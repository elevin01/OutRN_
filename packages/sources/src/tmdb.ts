import { z } from "zod";
import { guardedFetch, type GuardedFetchOptions } from "./fetch.js";

/**
 * The films people are going to now, from TMDB (The Movie Database): what is playing in US cinemas
 * (/movie/now_playing, region US) and what is trending this week (/trending/movie/week), each with
 * TMDB's popularity (its measure of activity on the site, not box office). Needs a key in the
 * environment (TMDB_API_KEY: a v3 API key, or a v4 read access token, which is sent as a bearer
 * token); never saved, logged or put in an error. What it says is kept as it says it.
 */

export const TMDB_API = "https://api.themoviedb.org/3";
const NOW_PLAYING_PAGES = 5;
const TRENDING_PAGES = 2;

/** One film as TMDB lists it. */
export interface FilmNow {
  id: number;
  title: string;
  originalTitle: string | null;
  popularity: number;
  releaseDate: string | null;
}

/** What `ingest films --save` writes, and a replay reads. */
export interface FilmsCapture {
  outrn_capture: "tmdb-films";
  fetchedAt: string;
  films: FilmNow[];
}

const Movie = z
  .object({
    id: z.number().int().min(1),
    title: z.string().min(1).max(300),
    original_title: z.string().max(300).optional(),
    popularity: z.number().min(0).optional(),
    release_date: z.string().max(20).optional(),
    adult: z.boolean().optional(),
  })
  .passthrough();
const Page = z.object({ page: z.number().int().min(1), total_pages: z.number().int().min(0), results: z.array(z.unknown()).max(100) }).passthrough();

export function parseTmdbPage(json: unknown): { films: FilmNow[]; totalPages: number } {
  const page = Page.parse(json);
  const films: FilmNow[] = [];
  for (const raw of page.results) {
    const m = Movie.safeParse(raw);
    // Adult titles are not something OutRN suggests.
    if (!m.success || m.data.adult) continue;
    films.push({ id: m.data.id, title: m.data.title.trim(), originalTitle: m.data.original_title?.trim() || null, popularity: m.data.popularity ?? 0, releaseDate: m.data.release_date?.trim() || null });
  }
  return { films, totalPages: page.total_pages };
}

/** The films from several pages, once each (the most popular reading), most popular first. */
export function mergeFilms(lists: readonly FilmNow[][]): FilmNow[] {
  const byId = new Map<number, FilmNow>();
  for (const f of lists.flat()) {
    const had = byId.get(f.id);
    if (!had || f.popularity > had.popularity) byId.set(f.id, f);
  }
  return [...byId.values()].sort((a, b) => b.popularity - a.popularity || a.id - b.id);
}

export async function fetchFilmsNow(key: string): Promise<FilmsCapture> {
  const token = key.trim();
  if (!token) throw new Error("tmdb: no key");
  // A v4 read access token is a JWT, sent as a bearer token; a v3 key goes in the query.
  const bearer = token.startsWith("eyJ");
  const opts: GuardedFetchOptions = { sourceId: "tmdb", accept: "application/json", allowedContentTypes: ["application/json"], minIntervalMs: 250, timeoutMs: 20_000, maxBytes: 5 * 1024 * 1024, ...(bearer ? { headers: { authorization: `Bearer ${token}` } } : {}) };
  const read = async (path: string, params: Record<string, string>) => {
    const u = new URL(`${TMDB_API}${path}`);
    u.search = new URLSearchParams({ ...params, ...(bearer ? {} : { api_key: token }) }).toString();
    return parseTmdbPage(JSON.parse((await guardedFetch(u.toString(), opts)).text));
  };
  const lists: FilmNow[][] = [];
  for (let page = 1; page <= NOW_PLAYING_PAGES; page++) {
    const r = await read("/movie/now_playing", { region: "US", language: "en-US", page: String(page) });
    lists.push(r.films);
    if (page >= r.totalPages) break;
  }
  for (let page = 1; page <= TRENDING_PAGES; page++) {
    const r = await read("/trending/movie/week", { language: "en-US", page: String(page) });
    lists.push(r.films);
    if (page >= r.totalPages) break;
  }
  return { outrn_capture: "tmdb-films", fetchedAt: new Date().toISOString(), films: mergeFilms(lists) };
}

const Capture = z.object({
  outrn_capture: z.literal("tmdb-films"),
  fetchedAt: z.string().datetime(),
  films: z.array(z.object({ id: z.number().int().min(1), title: z.string().min(1).max(300), originalTitle: z.string().max(300).nullable(), popularity: z.number().min(0), releaseDate: z.string().max(20).nullable() })).max(1000),
});

export function parseFilmsCapture(data: unknown, label: string): FilmsCapture {
  const c = Capture.safeParse(data);
  if (!c.success) throw new Error(`${label} is not a TMDB films capture (outrn ingest films --save)`);
  return c.data;
}
