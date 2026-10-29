import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { testDatabaseAvailable, reset } from "@outrn/db";
import { FetchFailed } from "../../sources/src/fetch.js";
import { refreshFilmPopularity } from "../src/films.js";
import { nextDue, REFRESH_JOBS, RETRY_MINUTES, runRefresh, type RefreshJob } from "../src/refresh.js";
import { ingestTicketedEvents } from "../src/ticketing.js";

// Every request a live job would send: here, whatever the test says it answers.
const fetchMock = vi.hoisted(() => ({ next: (_url: string): Promise<{ text: string }> => Promise.reject(new Error("no request expected")) }));
vi.mock("../../sources/src/fetch.js", async (orig) => ({ ...(await orig<typeof import("../../sources/src/fetch.js")>()), guardedFetch: (url: string) => fetchMock.next(url) }));

/** The refresh loop: which jobs are due, which can't run, and that one failure stops nothing else (outrn_test, reset per file). */

const BASE = process.env["DATABASE_URL"] ?? "postgres://outrn@127.0.0.1:54329/outrn";
const TEST_URL = BASE.replace(/\/[^/]+$/, "/outrn_test");
const NOW = new Date("2026-10-29T22:00:00Z");
const minutes = (n: number) => n * 60_000;

describe("when a job is next due", () => {
  const hourly = { everyMinutes: 60 };
  const daily = { everyMinutes: 24 * 60 };
  it("never run: now; after a success: its cadence later", () => {
    expect(nextDue(hourly, { lastSuccess: null, lastFailure: null }).getTime()).toBe(0);
    expect(nextDue(daily, { lastSuccess: NOW, lastFailure: null })).toEqual(new Date(NOW.getTime() + minutes(24 * 60)));
  });
  it("after a failure: the retry, or its own cadence when that is shorter; never before its success's cadence", () => {
    expect(nextDue(daily, { lastSuccess: null, lastFailure: NOW })).toEqual(new Date(NOW.getTime() + minutes(RETRY_MINUTES)));
    expect(nextDue({ everyMinutes: 10 }, { lastSuccess: null, lastFailure: NOW })).toEqual(new Date(NOW.getTime() + minutes(10)));
    // A failure before the last success says nothing any more.
    expect(nextDue(hourly, { lastSuccess: NOW, lastFailure: new Date(NOW.getTime() - minutes(5)) })).toEqual(new Date(NOW.getTime() + minutes(60)));
    // A failure right after a success waits for whichever comes later.
    expect(nextDue({ everyMinutes: 60 }, { lastSuccess: new Date(NOW.getTime() - minutes(50)), lastFailure: NOW })).toEqual(new Date(NOW.getTime() + minutes(RETRY_MINUTES)));
  });
  it("every job has a cadence and a source", () => {
    for (const j of REFRESH_JOBS) {
      expect(j.everyMinutes, j.id).toBeGreaterThan(0);
      expect(j.sourceId, j.id).toBeTruthy();
    }
    expect(new Set(REFRESH_JOBS.map((j) => j.id)).size).toBe(REFRESH_JOBS.length);
  });
});

let db: pg.Pool;
const available = await testDatabaseAvailable(BASE);

beforeAll(async () => {
  if (!available) return;
  const admin = new pg.Pool({ connectionString: BASE });
  try {
    const exists = await admin.query("select 1 from pg_database where datname = 'outrn_test'");
    if (!exists.rowCount) await admin.query("create database outrn_test");
  } finally {
    await admin.end();
  }
  db = new pg.Pool({ connectionString: TEST_URL });
  await db.query("create extension if not exists postgis; create extension if not exists pgcrypto;");
  await reset(db);
});

afterAll(async () => {
  if (db) await db.end();
});

describe.skipIf(!available)("the refresh loop", () => {
  const job = (id: string, sourceId: string, run: RefreshJob["run"], extra: Partial<RefreshJob> = {}): RefreshJob => ({ id, title: id, sourceId, everyMinutes: 60, run, ...extra });

  it("runs what is due once; skips a switched-off source or a missing key, saying why; a failure stops nothing else", async () => {
    await db.query(`update source_policies set enabled = false where id = 'nyc_parks'`);
    const ran: string[] = [];
    const lines: string[] = [];
    const runs = await runRefresh(db, {
      once: true,
      clock: () => NOW,
      env: {},
      log: (l) => lines.push(l),
      jobs: [
        job("broken", "nws", async () => {
          throw new Error("api.weather.gov answered 503");
        }),
        job("forecast", "nws", async () => (ran.push("forecast"), "3 areas")),
        job("parks", "nyc_parks", async () => (ran.push("parks"), "x")),
        job("tickets", "nws", async () => (ran.push("tickets"), "x"), { needs: ["OUTRN_TEST_NO_SUCH_KEY"] }),
      ],
    });
    expect(ran).toEqual(["forecast"]);
    expect(runs.map((r) => [r.job, r.outcome])).toEqual([
      ["broken", "failed"],
      ["forecast", "succeeded"],
      ["parks", "skipped"],
      ["tickets", "skipped"],
    ]);
    expect(runs.find((r) => r.job === "parks")!.detail).toMatch(/nyc_parks is switched off/);
    expect(runs.find((r) => r.job === "tickets")!.detail).toMatch(/needs OUTRN_TEST_NO_SUCH_KEY/);
    expect(lines.some((l) => /broken: failed, api.weather.gov answered 503; trying again in 30 min/.test(l))).toBe(true);
  });

  it("a source's last live run counts after a restart; a replay doesn't", async () => {
    await db.query(`insert into ingestion_runs (source_id, kind, started_at, finished_at, status) values ('calendars', 'calendar_feeds', $1, $1, 'succeeded')`, [new Date(NOW.getTime() - minutes(60))]);
    await db.query(`insert into ingestion_runs (source_id, kind, started_at, finished_at, status) values ('firstparty', 'replay', $1, $1, 'succeeded')`, [new Date(NOW.getTime() - minutes(5))]);
    const ran: string[] = [];
    await runRefresh(db, {
      once: true,
      clock: () => NOW,
      jobs: [job("calendars", "calendars", async () => (ran.push("calendars"), "x"), { everyMinutes: 24 * 60 }), job("sites", "firstparty", async () => (ran.push("sites"), "x"), { everyMinutes: 180 })],
    });
    expect(ran).toEqual(["sites"]);
  });

  it("in a loop: a failed job is tried again after the retry, a done one waits for its cadence, and it stops when asked", async () => {
    let now = NOW.getTime();
    const stop = new AbortController();
    const ran: string[] = [];
    let attempts = 0;
    let passes = 0;
    await runRefresh(db, {
      clock: () => new Date(now),
      signal: stop.signal,
      sleep: async () => {
        passes++;
        now += minutes(RETRY_MINUTES + 1);
        if (passes === 2) stop.abort();
      },
      jobs: [
        job("flaky", "nws", async () => {
          if (++attempts === 1) throw new Error("timeout");
          ran.push("flaky");
          return "ok";
        }),
        job("steady", "osm", async () => (ran.push("steady"), "ok"), { everyMinutes: 24 * 60 }),
      ],
    });
    expect(attempts).toBe(2);
    expect(ran).toEqual(["steady", "flaky"]);
  });
});

describe.skipIf(!available)("the refresh loop and the sources' own runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "outrn-refresh-"));
  const NOW2 = new Date("2026-10-29T16:00:00Z");

  it("a replayed ticketing or films capture does not count as the source's live read", async () => {
    await db.query(`update source_policies set enabled = true where id in ('ticketmaster', 'tmdb')`);
    const tickets = join(dir, "tm.json");
    writeFileSync(tickets, JSON.stringify({ outrn_capture: "ticketed-events", source: "ticketmaster", fetchedAt: NOW2.toISOString(), area: "les", complete: true, events: [{ id: "tm-r1", title: "Replay Night", url: null, start: "2026-10-30T00:00:00.000Z", status: "scheduled", venue: { name: "Pier 36", address: null, lat: 40.7101, lon: -73.9826 }, kinds: [], price: null, adultsOnly: false, popularity: null }] }));
    const films = join(dir, "films.json");
    writeFileSync(films, JSON.stringify({ outrn_capture: "tmdb-films", fetchedAt: NOW2.toISOString(), films: [{ id: 1, title: "Anora", originalTitle: null, popularity: 1, releaseDate: null }] }));
    await ingestTicketedEvents(db, { source: "ticketmaster", areaSlug: "les", now: NOW2, fromFile: tickets });
    await refreshFilmPopularity(db, { now: NOW2, fromFile: films });
    const kinds = (await db.query<{ source_id: string; kind: string }>(`select source_id, kind from ingestion_runs where source_id in ('ticketmaster', 'tmdb')`)).rows;
    expect(kinds.map((k) => k.kind)).toEqual(["replay", "replay"]);
    const ran: string[] = [];
    await runRefresh(db, {
      once: true,
      clock: () => new Date(NOW2.getTime() + 60_000),
      env: { K: "x" },
      jobs: [
        { id: "tm", title: "tm", sourceId: "ticketmaster", everyMinutes: 360, needs: ["K"], run: async () => (ran.push("tm"), "x") },
        { id: "films", title: "films", sourceId: "tmdb", everyMinutes: 180, needs: ["K"], run: async () => (ran.push("films"), "x") },
      ],
    });
    expect(ran).toEqual(["tm", "films"]);
  });

  it("a keyed API's failure reaches neither the job's error nor the refresh log with its key", async () => {
    const KEY = "synthetic-review-secret-69";
    const lines: string[] = [];
    for (const [id, env] of [["ticketmaster", { TICKETMASTER_API_KEY: KEY }], ["seatgeek", { SEATGEEK_CLIENT_ID: KEY }], ["films", { TMDB_API_KEY: KEY }]] as const) {
      await db.query(`update source_policies set enabled = true where id = $1`, [id === "films" ? "tmdb" : id]);
      fetchMock.next = (url) => Promise.reject(new FetchFailed(`400 from api.example: Invalid API credential: ${KEY} (${url})`, 400));
      const runs = await runRefresh(db, { once: true, clock: () => NOW2, env, log: (l) => lines.push(l), jobs: REFRESH_JOBS.filter((j) => j.id === id) });
      expect(runs).toEqual([{ job: id, outcome: "failed", detail: expect.stringMatching(/: the API answered 400$/) }]);
    }
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.filter((l) => l.includes(KEY) || l.includes(encodeURIComponent(KEY)))).toEqual([]);
  });
});
