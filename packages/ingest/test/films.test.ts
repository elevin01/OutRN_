import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { testDatabaseAvailable, reset } from "@outrn/db";
import type { FilmNow, FilmsCapture } from "@outrn/sources";
import { ingestEvents } from "../src/events.js";
import { filmTitleKey, filmTitleKeys, popularFilms, refreshFilmPopularity } from "../src/films.js";
import { ingestOsmArea } from "../src/pipeline.js";

/** Popular films matched to screenings, against a real Postgres + PostGIS (outrn_test, reset per file). */

const BASE = process.env["DATABASE_URL"] ?? "postgres://outrn@127.0.0.1:54329/outrn";
const TEST_URL = BASE.replace(/\/[^/]+$/, "/outrn_test");
const FIXTURE = resolve(__dirname, "../../../fixtures/osm/les-synthetic.json");
const NOW = new Date("2026-10-03T16:00:00Z");

describe("a screening's film title", () => {
  it("sets aside a series' prefix, the print, a talk after, and reads punctuation and & alike", () => {
    expect(filmTitleKeys("Anora (35mm)")).toEqual(["anora"]);
    expect(filmTitleKey("ANORA")).toBe("anora");
    expect(filmTitleKeys("Dune: Part Two (70mm) + Q&A")).toEqual(["dune part two q and a", "dune part two"]);
    expect(filmTitleKey("Movie Night: Wicked")).toBe("wicked");
    expect(filmTitleKey("Movies Under the Stars: Inside Out 2")).toBe("inside out 2");
    expect(filmTitleKeys("The Brutalist - with director Q&A")).toContain("the brutalist");
    expect(filmTitleKeys("The Brutalist: Q&A with the director")).toContain("the brutalist");
    expect(filmTitleKey("Wallace & Gromit: Vengeance Most Fowl")).toBe("wallace and gromit vengeance most fowl");
    expect(filmTitleKey("Amélie [Open Caption]")).toBe("amelie");
    expect(filmTitleKey("Nosferatu in 70mm")).toBe("nosferatu");
    // A film's own subtitle is its name, matched first: the series' next film is not this one.
    expect(filmTitleKey("Mission: Impossible – The Final Reckoning")).toBe("mission impossible the final reckoning");
  });

  it("the most popular twenty, by every title they go by; one short word is too little to match", () => {
    const film = (id: number, title: string, originalTitle: string | null = null): FilmNow => ({ id, title, originalTitle, popularity: 100 - id, releaseDate: null });
    const p = popularFilms([film(1, "Wicked"), film(2, "Up"), film(3, "Amélie", "Le Fabuleux Destin d'Amélie Poulain"), ...Array.from({ length: 30 }, (_, i) => film(10 + i, `Film ${i}`))]);
    expect(p.get("wicked")).toMatchObject({ rank: 1, score: 1 });
    expect(p.get("up")).toBeUndefined();
    expect(p.get("le fabuleux destin d amelie poulain")?.rank).toBe(3);
    expect(p.get("film 6")).toMatchObject({ rank: 10, score: 0.7 });
    expect(p.get("film 25")).toBeUndefined();
  });
});

let db: pg.Pool;
const available = await testDatabaseAvailable(BASE);
const dir = mkdtempSync(join(tmpdir(), "outrn-films-"));

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
  await ingestOsmArea(db, { areaSlug: "les", fromFile: FIXTURE });
  // Registered disabled until its terms are reviewed (0029); these tests stand in for that review.
  await db.query(`update source_policies set enabled = true where id = 'tmdb'`);
});

afterAll(async () => {
  if (db) await db.end();
});

let n = 0;
const capture = (titles: string[]) => {
  const path = join(dir, `films-${n++}.json`);
  const films = titles.map((title, i) => ({ id: i + 1, title, originalTitle: title, popularity: 1000 - i, releaseDate: null }));
  writeFileSync(path, JSON.stringify({ outrn_capture: "tmdb-films", fetchedAt: NOW.toISOString(), films } satisfies FilmsCapture));
  return path;
};
const popularity = async (title: string) =>
  (await db.query<{ value: { score: number; source: string; rank: number } }>(`select f.value from current_facts f join occurrences o on o.id = f.subject_id where f.subject_kind = 'occurrence' and f.attribute = 'popularity' and o.title = $1`, [title])).rows[0]?.value;

describe.skipIf(!available)("popular films", () => {
  it("marks screenings of a popular film at a cinema or a film night; not a concert that shares a film's name", async () => {
    const show = (id: string, title: string, place: Record<string, unknown>, kinds?: string[]) => ({ id, title, start: "2026-10-03T23:00:00Z", place, evidence: "listing", ...(kinds ? { kinds } : {}) });
    await ingestEvents(
      db,
      {
        source: "founder",
        events: [
          show("s1", "Wicked (Sing-Along)", { venue: "Broome Cinema" }),
          show("s2", "Movie Night: Anora", { name: "Seward Park Lawn", lat: 40.7144, lon: -73.9894 }, ["film"]),
          show("s3", "Wicked", { name: "Seward Park Bandshell", lat: 40.7146, lon: -73.9897 }, ["live_music"]),
          show("s4", "Nosferatu", { venue: "Ridge Cinema" }),
          show("s5", "Mission: Impossible – Dead Reckoning (35mm)", { venue: "Ridge Cinema" }),
        ],
      },
      { areaSlug: "les", now: NOW },
    );
    const s = await refreshFilmPopularity(db, { now: NOW, fromFile: capture(["Wicked", "Anora", "Mission: Impossible - The Final Reckoning", ...Array.from({ length: 25 }, (_, i) => `Other ${i}`), "Nosferatu"]) });
    expect([s.screenings, s.popular]).toEqual([4, 2]);
    // The series' earlier film is not the one people are going to.
    expect(await popularity("Mission: Impossible – Dead Reckoning (35mm)")).toBeUndefined();
    expect(await popularity("Wicked (Sing-Along)")).toEqual({ score: 1, source: "tmdb", rank: 1 });
    expect(await popularity("Movie Night: Anora")).toMatchObject({ rank: 2 });
    // A concert called "Wicked" is not a screening of it; Nosferatu is playing, but not among the most popular.
    expect(await popularity("Wicked")).toBeUndefined();
    expect(await popularity("Nosferatu")).toBeUndefined();
  });

  it("a film that falls out of the most popular loses its mark on the next refresh", async () => {
    const s = await refreshFilmPopularity(db, { now: NOW, fromFile: capture(["Anora", "Conclave"]) });
    expect(s.retracted).toBe(1);
    expect(await popularity("Wicked (Sing-Along)")).toBeUndefined();
    expect(await popularity("Movie Night: Anora")).toMatchObject({ rank: 1, score: 1 });
  });

  it("refuses while the source is switched off, or live without its key", async () => {
    await db.query(`update source_policies set enabled = false where id = 'tmdb'`);
    try {
      await expect(refreshFilmPopularity(db, { now: NOW, fromFile: capture(["Anora"]) })).rejects.toThrow(/tmdb: disabled/);
    } finally {
      await db.query(`update source_policies set enabled = true where id = 'tmdb'`);
    }
    await expect(refreshFilmPopularity(db, { now: NOW, env: {} })).rejects.toThrow(/set TMDB_API_KEY/);
  });
});
