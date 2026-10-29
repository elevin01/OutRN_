import { getSourcePolicy, isServedArea, listAreas, type Db } from "@outrn/db";
import { ingestCalendars } from "./calendars.js";
import { refreshFilmPopularity, TMDB_KEY } from "./films.js";
import { discoverSites, runFirstParty } from "./firstparty-job.js";
import { ingestNycParksEvents } from "./nyc-parks.js";
import { AI_ENV, readEventsWithClaude, recheckEventsWithClaude } from "./site-ai.js";
import { ingestTicketedEvents, TICKETING_KEYS } from "./ticketing.js";
import { refreshWeather } from "./weather.js";

/**
 * The live jobs that keep what is happening current, each on its own cadence: the forecast hourly,
 * events and the venues' own sites daily or so. `outrn refresh` runs them in a loop beside the API
 * (`pnpm real` starts it), or once (`--once`) from a scheduler. A job runs only when its source is
 * switched on in source_policies and what it needs from the environment (an API key) is set; a job
 * that can't run is said once and skipped, never forced. A failed job is tried again after
 * RETRY_MINUTES (or its own cadence, if shorter), and the others carry on.
 */

export interface RefreshJob {
  id: string;
  /** What it does, for `outrn refresh --list` and the log. */
  title: string;
  /** The source whose policy must be on, and whose last successful run says when it last ran. */
  sourceId: string;
  everyMinutes: number;
  /** Environment variables it can't run without (an API key). */
  needs?: readonly string[];
  /** Runs the job with the environment the loop checked its needs in; returns a one-line summary. */
  run: (db: Db, log: (line: string) => void, env: Readonly<Record<string, string | undefined>>) => Promise<string>;
}

export const RETRY_MINUTES = 30;

const servedSlugs = async (db: Db): Promise<string[]> => (await listAreas(db)).filter(isServedArea).map((a) => a.slug);

export const REFRESH_JOBS: readonly RefreshJob[] = [
  {
    id: "weather",
    title: "the National Weather Service's hourly forecast for each served area",
    sourceId: "nws",
    everyMinutes: 60,
    run: async (db, log) => `${(await refreshWeather(db, { log })).length} areas`,
  },
  {
    id: "nyc_parks",
    title: "NYC Parks' events for the next two weeks (NYC Open Data, refreshed daily)",
    sourceId: "nyc_parks",
    everyMinutes: 12 * 60,
    run: async (db, log) => {
      const parts: string[] = [];
      for (const slug of await servedSlugs(db)) {
        const s = await ingestNycParksEvents(db, { areaSlug: slug, log });
        parts.push(`${slug} ${s.written} events, ${s.withdrawn} withdrawn`);
      }
      return parts.join(" · ") || "no served areas";
    },
  },
  {
    id: "calendars",
    title: "libraries', towns' and nature centers' own calendars (the next 30 days)",
    sourceId: "calendars",
    everyMinutes: 24 * 60,
    run: async (db, log) => {
      const s = await ingestCalendars(db, { log });
      const written = s.areas.reduce((n, a) => n + a.written, 0);
      return `${s.reads.filter((r) => r.status === "ok").length} of ${s.reads.length} feeds · ${written} events`;
    },
  },
  {
    id: "venue_sites",
    title: "the venues' own websites: hours, and what theatres, cinemas and music rooms list",
    sourceId: "firstparty",
    // Each site keeps its own fetch interval (a day, more after a refusal): this only looks for due
    // ones, theatres', cinemas' and music rooms' first, a few hundred an hour until all have been read.
    everyMinutes: 60,
    run: async (db, log) => {
      let registered = 0;
      for (const slug of await servedSlugs(db)) registered += (await discoverSites(db, { areaSlug: slug })).registered;
      const s = await runFirstParty(db, { limit: 300, log });
      return `${registered} new sites · ${s.sites} due · ${s.ok} read · ${s.occurrences} events · ${s.hours} with hours`;
    },
  },
  ...(["ticketmaster", "seatgeek"] as const).map(
    (source): RefreshJob => ({
      id: source,
      title: `${source === "ticketmaster" ? "Ticketmaster's" : "SeatGeek's"} ticketed events for the next two weeks: concerts, comedy, theatre, sports`,
      sourceId: source,
      everyMinutes: 6 * 60,
      needs: [TICKETING_KEYS[source]],
      run: async (db, log, env) => {
        const parts: string[] = [];
        for (const slug of await servedSlugs(db)) {
          const s = await ingestTicketedEvents(db, { source, areaSlug: slug, log, env });
          parts.push(`${slug} ${s.written} events, ${s.withdrawn} withdrawn`);
        }
        return parts.join(" · ") || "no served areas";
      },
    }),
  ),
  {
    id: "films",
    title: "which screenings are of the films people are going to now (TMDB's most popular)",
    sourceId: "tmdb",
    // After the venues' sites and the ticketing reads, so a new screening is matched within hours.
    everyMinutes: 3 * 60,
    needs: [TMDB_KEY],
    run: async (db, log, env) => {
      const s = await refreshFilmPopularity(db, { log, env });
      return `${s.popular} of ${s.screenings} upcoming screenings are of a popular film`;
    },
  },
  {
    id: "ai_events",
    title: "Claude reads the events pages of venues that list events no other way (each page daily, within the day's cap)",
    sourceId: "site_ai",
    // After the venues' own sites, which list most of what can be listed without it.
    everyMinutes: 2 * 60,
    needs: [AI_ENV.key],
    run: async (db, log, env) => {
      const s = await readEventsWithClaude(db, { log, env });
      return `${s.read} of ${s.pages} pages read · ${s.events} events · $${s.costUsd.toFixed(4)}${s.stoppedForBudget ? " · at the day's cap" : ""}`;
    },
  },
  {
    id: "ai_recheck",
    title: "Claude re-checks the pages of events starting within 36 hours: cancelled or sold out now?",
    sourceId: "site_ai",
    everyMinutes: 2 * 60,
    needs: [AI_ENV.key],
    run: async (db, log, env) => {
      const s = await recheckEventsWithClaude(db, { log, env });
      return `${s.checked} of ${s.events} checked · ${s.marked.cancelled} cancelled · ${s.marked.sold_out} sold out · ${s.cleared} listed again · $${s.costUsd.toFixed(4)}${s.stoppedForBudget ? " · at the day's cap" : ""}`;
    },
  },
];

export interface JobState {
  /** The last time it succeeded (from the run log, so a restart picks up where it was). */
  lastSuccess: Date | null;
  /** The last time it failed in this process. */
  lastFailure: Date | null;
}

/** When a job is next due: its cadence after its last success, or the retry after a failure since. */
export function nextDue(job: Pick<RefreshJob, "everyMinutes">, state: JobState): Date {
  const after = (d: Date, minutes: number) => new Date(d.getTime() + minutes * 60_000);
  const bySuccess = state.lastSuccess ? after(state.lastSuccess, job.everyMinutes) : new Date(0);
  if (state.lastFailure && (!state.lastSuccess || state.lastFailure > state.lastSuccess)) {
    const retry = after(state.lastFailure, Math.min(RETRY_MINUTES, job.everyMinutes));
    return retry > bySuccess ? retry : bySuccess;
  }
  return bySuccess;
}

/** Why a job can't run at all right now (its source is off, a key is missing), or null when it can. */
export async function blockedBecause(db: Db, job: RefreshJob, env: Readonly<Record<string, string | undefined>>): Promise<string | null> {
  const missing = (job.needs ?? []).filter((k) => !env[k]?.trim());
  if (missing.length) return `needs ${missing.join(", ")} in the environment`;
  const p = await getSourcePolicy(db, job.sourceId);
  if (p.kill_switch) return `source ${job.sourceId}: kill switch is on`;
  if (!p.enabled) return `source ${job.sourceId} is switched off in source_policies`;
  return null;
}

/** The last time each source's live run succeeded (replays don't count: they are not news). */
async function lastSuccesses(db: Db, sourceIds: readonly string[]): Promise<Map<string, Date>> {
  const r = await db.query<{ source_id: string; at: Date }>(
    `select source_id, max(coalesce(finished_at, started_at)) as at from ingestion_runs
      where source_id = any($1::text[]) and status in ('succeeded', 'partial') and kind <> 'replay' group by source_id`,
    [[...sourceIds]],
  );
  return new Map(r.rows.map((x) => [x.source_id, new Date(x.at)]));
}

export interface RefreshOptions {
  jobs?: readonly RefreshJob[];
  /** Run each due job once and return, instead of looping. */
  once?: boolean;
  env?: Readonly<Record<string, string | undefined>>;
  clock?: () => Date;
  /** Waits between checks; resolves early when the signal aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  log?: (line: string) => void;
  /** How often the loop looks for due jobs. */
  checkEveryMs?: number;
}

export interface RefreshRun {
  job: string;
  outcome: "succeeded" | "failed" | "skipped";
  detail: string;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/** Runs the due jobs, once or until the signal aborts. Returns the latest runs (a skip once per reason). */
export async function runRefresh(db: Db, opts: RefreshOptions = {}): Promise<RefreshRun[]> {
  const jobs = opts.jobs ?? REFRESH_JOBS;
  const env = opts.env ?? process.env;
  const clock = opts.clock ?? (() => new Date());
  const sleep = opts.sleep ?? defaultSleep;
  const log = opts.log ?? (() => undefined);
  const state = new Map<string, JobState>();
  const known = await lastSuccesses(db, jobs.map((j) => j.sourceId));
  for (const j of jobs) state.set(j.id, { lastSuccess: known.get(j.sourceId) ?? null, lastFailure: null });
  // Said once per reason, not on every check.
  const said = new Map<string, string>();
  // The latest runs only: a loop that runs for weeks keeps no history of its own (ingestion_runs does).
  const runs: RefreshRun[] = [];
  const record = (r: RefreshRun) => {
    runs.push(r);
    if (runs.length > 200) runs.shift();
  };

  for (;;) {
    for (const job of jobs) {
      if (opts.signal?.aborted) return runs;
      const s = state.get(job.id)!;
      if (nextDue(job, s) > clock()) continue;
      const blocked = await blockedBecause(db, job, env);
      if (blocked) {
        if (said.get(job.id) !== blocked) {
          log(`${job.id}: skipped, ${blocked}`);
          record({ job: job.id, outcome: "skipped", detail: blocked });
        }
        said.set(job.id, blocked);
        continue;
      }
      said.delete(job.id);
      const t0 = Date.now();
      try {
        const detail = await job.run(db, (line) => log(`${job.id}: ${line}`), env);
        s.lastSuccess = clock();
        log(`${job.id}: ${detail} (${Math.round((Date.now() - t0) / 1000)} s)`);
        record({ job: job.id, outcome: "succeeded", detail });
      } catch (e) {
        s.lastFailure = clock();
        const detail = (e as Error).message;
        log(`${job.id}: failed, ${detail}; trying again in ${Math.min(RETRY_MINUTES, job.everyMinutes)} min`);
        record({ job: job.id, outcome: "failed", detail });
      }
    }
    if (opts.once || opts.signal?.aborted) return runs;
    await sleep(opts.checkEveryMs ?? 60_000, opts.signal);
  }
}
