import { readFile, writeFile } from "node:fs/promises";
import type { FactInput } from "@outrn/core";
import { assertSourceAllowed, withTx, type Db } from "@outrn/db";
import { materializeSubjects, retractSourceFacts, writeFacts } from "@outrn/facts";
import { fetchFilmsNow, finishRun, parseFilmsCapture, startRun, type FilmNow, type FilmsCapture } from "@outrn/sources";

/**
 * Which screenings are of the films people are going to now: TMDB's most popular films (now playing
 * in the US, or trending this week) matched by title to the screenings we list (at a cinema, or an
 * event that says it is a film: a park's movie night, a library's screening). A match is a
 * `popularity` fact on that screening, which the engine reads as "popular right now". Titles are
 * matched whole, once a screening's own extras are set aside ("Anora (35mm)", "Movie Night: Wicked",
 * "The Brutalist + Q&A"); a title that only contains a film's ("Wicked Little Letters") is not it.
 */

/** How many of TMDB's most popular films count. */
export const POPULAR_FILMS = 20;
/** How far ahead screenings are matched. */
const DAYS_AHEAD = 14;
/** TMDB_API_KEY: a v3 API key or a v4 read access token. */
export const TMDB_KEY = "TMDB_API_KEY";

/** A screening's own words around a film's title: a series' prefix, the print, a talk after. */
const PREFIX = /^\s*(?:(?:free\s+)?(?:outdoor\s+)?(?:movie|film|cinema|screening)s?(?:\s+(?:night|nite|club|series|under the stars|on the (?:lawn|green|pier|beach)))?|family movie night|summer movies?|sneak preview|special screening|opening night|members'? screening)\s*[:\-–|]\s*/i;
/** Wherever they are: what is in brackets, and how it is shown ("(35mm)", "in 70mm", "[Open Caption]"). */
const PRINT = /\s*(?:\([^)]*\)|\[[^\]]*\]|\b(?:in\s+)?(?:35|70|16)\s?mm\b|\bimax\b|\b3d\b|\b4k\b|\bopen caption(?:ed)?\b|\bsing-?along\b|\bdouble feature\b)/gi;
/** What a screening adds after its film: a talk, a guest, an introduction, a format. Never a film's own subtitle. */
const TALK = String.raw`(?:q\s*&\s*a|in person|with\s+(?:the\s+|its\s+)?(?:director|filmmakers?|cast|writer|star|actors?|special guests?|guests?)|intro(?:duction|duced by)?|discussion|conversation|talkback|panel|live score|sneak preview|preview|premiere|anniversary|restoration|director'?s cut|members'? screening|double feature|sing-?along)`;
/** At the end: such an addition after a dash, a plus or a colon ("The Brutalist - with director Q&A", "+ Q&A", ": Q&A with the cast"). */
const TRAILER = new RegExp(String.raw`\s*(?:\s[-–|+]\s|:\s*)${TALK}.*$`, "i");

const key = (t: string) =>
  t
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * The keys a title is matched by, closest first: the title with its series' prefix and print set
 * aside, then that without a talk or a guest after it. A film's own subtitle is never set aside
 * ("Mission: Impossible – Dead Reckoning" is not "Mission: Impossible"); a Q&A after it is.
 */
export function filmTitleKeys(title: string): string[] {
  const t = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(PREFIX, "");
  const whole = t.replace(PRINT, " ");
  const short = whole.replace(TRAILER, "");
  return [...new Set([key(whole), key(short)].filter(Boolean))];
}

/** A film title as matched (its closest key). */
export const filmTitleKey = (title: string): string => filmTitleKeys(title)[0] ?? "";

export interface PopularFilm {
  film: FilmNow;
  rank: number;
  /** 1 for the most popular; 0.7 for the tenth (the engine's line for "popular right now"). */
  score: number;
}

/** The most popular films (already ordered most popular first), by every title key they go by. */
export function popularFilms(films: readonly FilmNow[]): Map<string, PopularFilm> {
  const out = new Map<string, PopularFilm>();
  films.slice(0, POPULAR_FILMS).forEach((film, i) => {
    const p: PopularFilm = { film, rank: i + 1, score: +(1 - i / 30).toFixed(3) };
    for (const title of [film.title, film.originalTitle]) {
      const key = title ? filmTitleKey(title) : "";
      // A title of one short word ("Up", "It") would match too much that isn't it.
      if (key.length >= 3 && !out.has(key)) out.set(key, p);
    }
  });
  return out;
}

export interface FilmsRefreshOptions {
  fromFile?: string;
  saveTo?: string;
  env?: Readonly<Record<string, string | undefined>>;
  now?: Date;
  log?: (line: string) => void;
}

export interface FilmsRefreshSummary {
  runId: string;
  films: number;
  screenings: number;
  popular: number;
  retracted: number;
}

export async function refreshFilmPopularity(db: Db, opts: FilmsRefreshOptions = {}): Promise<FilmsRefreshSummary> {
  const log = opts.log ?? (() => undefined);
  await assertSourceAllowed(db, "tmdb", "derive");
  if (!opts.fromFile) await assertSourceAllowed(db, "tmdb", "fetch");
  const now = opts.now ?? new Date();
  let capture: FilmsCapture;
  if (opts.fromFile) capture = parseFilmsCapture(JSON.parse(await readFile(opts.fromFile, "utf8")), opts.fromFile);
  else {
    const key = (opts.env ?? process.env)[TMDB_KEY]?.trim();
    if (!key) throw new Error(`tmdb: set ${TMDB_KEY} in the environment (a free key from themoviedb.org)`);
    capture = await fetchFilmsNow(key);
    if (opts.saveTo) await writeFile(opts.saveTo, JSON.stringify(capture), "utf8");
  }
  if (!capture.films.length) throw new Error("tmdb: no films came back");
  const popular = popularFilms(capture.films);
  log(`${capture.films.length} films now · the ${Math.min(POPULAR_FILMS, capture.films.length)} most popular: ${capture.films.slice(0, 5).map((f) => f.title).join(", ")}…`);

  // A replay is not news: outrn refresh counts only live reads (kind <> 'replay').
  const runId = await startRun(db, { sourceId: "tmdb", kind: opts.fromFile ? "replay" : "films_now", params: { films: capture.films.length } });
  try {
    const s = await withTx(db, async (tx) => {
      const screenings = (
        await tx.query<{ id: string; title: string; tmdb: boolean }>(
          `select o.id, o.title,
                  exists (select 1 from facts f where f.subject_kind = 'occurrence' and f.subject_id = o.id and f.source_id = 'tmdb' and f.superseded_at is null) as tmdb
             from occurrences o join venues v on v.id = o.venue_id
            where o.status in ('scheduled', 'sold_out') and o.start_at > $1::timestamptz - interval '3 hours' and o.start_at < $1::timestamptz + make_interval(days => $2)
              and (v.category = 'cinema' or exists (select 1 from current_facts k where k.subject_kind = 'occurrence' and k.subject_id = o.id and k.attribute = 'event_kind' and k.value->'interests' ? 'film'))`,
          [now, DAYS_AHEAD],
        )
      ).rows;
      const changed: string[] = [];
      let matched = 0;
      let retracted = 0;
      for (const o of screenings) {
        const p = filmTitleKeys(o.title).map((k) => popular.get(k)).find((x) => x !== undefined);
        if (!p) {
          if (o.tmdb && (await retractSourceFacts(tx, "occurrence", o.id, "tmdb"))) {
            retracted++;
            changed.push(o.id);
          }
          continue;
        }
        matched++;
        const fact: FactInput = {
          subjectKind: "occurrence",
          subjectId: o.id,
          attribute: "popularity",
          value: { score: p.score, source: "tmdb", rank: p.rank },
          evidenceClass: "published",
          sourceId: "tmdb",
          evidence: `TMDB: "${p.film.title}" is #${p.rank} of the most popular films now playing or trending`,
          sourceUpdatedAt: new Date(capture.fetchedAt),
          fetchedAt: now,
          confidence: 0.7,
          lineageGroup: "tmdb",
          ingestionRunId: runId,
          // A film's place changes week to week: a day without a refresh and it no longer counts.
          validUntil: new Date(now.getTime() + 36 * 3_600_000),
        };
        const w = await writeFacts(tx, [fact]);
        if (w.rejected.length) throw new Error(`popularity fact rejected: ${w.rejected[0]!.reason}`);
        // Even unchanged: its validity moved, and current_facts carries it.
        changed.push(o.id);
      }
      if (changed.length) await materializeSubjects(tx, "occurrence", changed, now);
      return { screenings: screenings.length, popular: matched, retracted };
    });
    await finishRun(db, runId, { status: "succeeded", counts: { films: capture.films.length, ...s } });
    return { runId, films: capture.films.length, ...s };
  } catch (err) {
    await finishRun(db, runId, { status: "failed", error: (err as Error).message.slice(0, 500) });
    throw err;
  }
}
