import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { reset, testDatabaseAvailable } from "@outrn/db";
import { commonsImageInfoUrl, replayWikimediaFetcher, type WikimediaCapture } from "@outrn/sources";
import { ingestPhotos } from "../src/photos.js";
import { ingestOsmArea } from "../src/pipeline.js";

/** The photo job, replayed from the synthetic capture, against a real Postgres + PostGIS. */

const BASE = process.env["DATABASE_URL"] ?? "postgres://outrn@127.0.0.1:54329/outrn";
const TEST_URL = BASE.replace(/\/[^/]+$/, "/outrn_test");
const OSM = resolve(__dirname, "../../../fixtures/osm/les-synthetic.json");
const CAPTURE = resolve(__dirname, "../../../fixtures/wikimedia/les-synthetic.json");

let db: pg.Pool;
const available = await testDatabaseAvailable(BASE);

beforeAll(async () => {
  if (!available) return;
  const admin = new pg.Pool({ connectionString: BASE });
  try {
    if (!(await admin.query("select 1 from pg_database where datname = 'outrn_test'")).rowCount) await admin.query("create database outrn_test");
  } finally {
    await admin.end();
  }
  db = new pg.Pool({ connectionString: TEST_URL });
  await db.query("create extension if not exists postgis; create extension if not exists pgcrypto;");
  await reset(db);
  await ingestOsmArea(db, { areaSlug: "les", fromFile: OSM });
});

afterAll(async () => {
  if (db) await db.end();
});

const photos = async () =>
  (
    await db.query<{ venue: string; rank: number; license: string; author: string | null; via: string; alt: string | null }>(
      `select v.canonical_name as venue, p.rank, p.license, p.author, p.via, p.alt from venue_photos p join venues v on v.id = p.venue_id order by v.canonical_name, p.rank`,
    )
  ).rows;

const tmp = (name: string, data: unknown) => {
  const path = join(mkdtempSync(join(tmpdir(), "outrn-")), name);
  writeFileSync(path, JSON.stringify(data));
  return path;
};

describe.skipIf(!available)("venue photos from Wikimedia Commons (replayed)", () => {
  it("keeps free, credited photos the venue's records name, lead first; skips the rest", async () => {
    const s = await ingestPhotos(db, { areaSlug: "les", fromFile: CAPTURE });
    // Pitt Park, Norfolk Park, Delancey Books and East River Overlook name files; the map (SVG), the
    // non-free shop window and the uncredited CC BY view are skipped.
    expect(s).toMatchObject({ venues: 4, withPhotos: 2, photos: 3, skipped: 3 });
    expect(await photos()).toEqual([
      { venue: "Norfolk Park", rank: 0, license: "Public domain", author: "Unknown author", via: "osm:image", alt: "OutRN synthetic Norfolk Park" },
      { venue: "Pitt Park", rank: 0, license: "CC BY-SA 4.0", author: "Synthetic Photographer", via: "osm:wikimedia_commons", alt: "The lawn at Pitt Park on a summer evening (synthetic fixture: this file does not exist)" },
      { venue: "Pitt Park", rank: 1, license: "CC0", author: null, via: "wikidata:P18", alt: "Fountain in Pitt Park & its benches (synthetic fixture)" },
    ]);
    // Replaying the same capture changes nothing.
    await ingestPhotos(db, { areaSlug: "les", fromFile: CAPTURE });
    expect(await photos()).toHaveLength(3);
  });

  it("a tag removed upstream, or a file relicensed on Commons, takes its photo along", async () => {
    const osm = JSON.parse(readFileSync(OSM, "utf8")) as { elements: { tags: Record<string, string> }[] };
    const pitt = osm.elements.find((e) => e.tags["name"] === "Pitt Park")!;
    delete pitt.tags["wikimedia_commons"];
    delete pitt.tags["wikidata"];
    await ingestOsmArea(db, { areaSlug: "les", fromFile: tmp("les-untagged.json", osm) });

    // What Commons now says about the remaining files: the Norfolk Park photo is no longer free.
    const capture = JSON.parse(readFileSync(CAPTURE, "utf8")) as WikimediaCapture;
    const commons = Object.entries(capture.responses).find(([url]) => url.startsWith("https://commons.wikimedia.org/"))![1] as { query: { pages: { title: string; imageinfo: { extmetadata: Record<string, { value: string }> }[] }[] } };
    const pages = commons.query.pages.filter((p) => !p.title.includes("Pitt Park"));
    pages.find((p) => p.title.includes("Norfolk"))!.imageinfo[0]!.extmetadata["LicenseShortName"] = { value: "Fair use" };
    const titles = pages.map((p) => p.title).sort();
    const s = await ingestPhotos(db, { areaSlug: "les", fromFile: tmp("wm.json", { outrn_capture: "wikimedia", responses: { [commonsImageInfoUrl(titles)]: { query: { pages } } } }) });
    expect(s).toMatchObject({ venues: 3, withPhotos: 0, photos: 0 });
    expect(await photos()).toEqual([]);

    // Back as they were.
    await ingestOsmArea(db, { areaSlug: "les", fromFile: OSM });
    await ingestPhotos(db, { areaSlug: "les", fromFile: CAPTURE });
    expect(await photos()).toHaveLength(3);
  });

  type CapturedPage = { title: string; templates?: { ns: number; title: string }[]; imageinfo: { timestamp: string; extmetadata: Record<string, { value: string }> }[] };
  /** The synthetic capture, with a change to what Commons says about one file. */
  const captureEditing = (title: string, edit: (page: CapturedPage) => void): WikimediaCapture => {
    const capture = JSON.parse(readFileSync(CAPTURE, "utf8")) as WikimediaCapture;
    for (const response of Object.values(capture.responses) as { query?: { pages?: CapturedPage[] } }[]) {
      const page = response.query?.pages?.find((p) => p.title === title);
      if (page) edit(page);
    }
    return capture;
  };
  const captureWith = (title: string, meta: Record<string, string>) =>
    captureEditing(title, (page) => {
      for (const [k, v] of Object.entries(meta)) page.imageinfo[0]!.extmetadata[k] = { value: v };
    });

  it("a file freshly uploaded over, or tagged for deletion on Commons, loses its place until it settles", async () => {
    const now = new Date("2026-09-26T12:00:00Z");
    const reuploaded = captureEditing("File:OutRN synthetic Norfolk Park.jpg", (page) => (page.imageinfo[0]!.timestamp = "2026-09-20T08:00:00Z"));
    expect(await ingestPhotos(db, { areaSlug: "les", fromFile: tmp("reuploaded.json", reuploaded), clock: () => now })).toMatchObject({ photos: 2, skipped: 4 });
    expect((await photos()).map((p) => p.venue)).toEqual(["Pitt Park", "Pitt Park"]);
    // A month on, the same answer shows it again.
    expect(await ingestPhotos(db, { areaSlug: "les", fromFile: tmp("reuploaded.json", reuploaded), clock: () => new Date("2026-10-21T12:00:00Z") })).toMatchObject({ photos: 3 });

    const nominated = captureEditing("File:OutRN synthetic Pitt Park lawn.jpg", (page) => (page.templates = [{ ns: 10, title: "Template:Delete" }]));
    expect(await ingestPhotos(db, { areaSlug: "les", fromFile: tmp("nominated.json", nominated), clock: () => now })).toMatchObject({ photos: 2, skipped: 4 });
    expect((await db.query(`select 1 from venue_photos where file_title = 'File:OutRN synthetic Pitt Park lawn.jpg'`)).rowCount).toBe(0);
    await ingestPhotos(db, { areaSlug: "les", fromFile: CAPTURE });
  });

  it("malformed metadata from Commons can't fail the run: an entity that names no character is kept as written", async () => {
    const capture = captureWith("File:OutRN synthetic Pitt Park lawn.jpg", { Artist: "Synthetic &#1114112; Photographer", ImageDescription: "&#xD800; lawn" });
    const s = await ingestPhotos(db, { areaSlug: "les", fromFile: tmp("malformed.json", capture) });
    expect(s).toMatchObject({ photos: 3, skipped: 3 });
    const lawn = await db.query<{ author: string; alt: string }>(`select author, alt from venue_photos where file_title = 'File:OutRN synthetic Pitt Park lawn.jpg'`);
    expect(lawn.rows[0]).toEqual({ author: "Synthetic &#1114112; Photographer", alt: "&#xD800; lawn" });
    await ingestPhotos(db, { areaSlug: "les", fromFile: CAPTURE });
  });

  it("a live run that can't save its capture changes nothing; one that can saves exactly what it used", async () => {
    // What Commons would now say: the Norfolk Park photo is no longer free, so a completed run would drop it.
    const relicensed = replayWikimediaFetcher(captureWith("File:OutRN synthetic Norfolk Park.jpg", { LicenseShortName: "Fair use" }));
    const before = await photos();
    await expect(ingestPhotos(db, { areaSlug: "les", fetcher: relicensed, saveTo: join(tmpdir(), "outrn-no-such-dir", "nested", "capture.json") })).rejects.toThrow(/ENOENT/);
    expect(await photos()).toEqual(before);
    const failed = await db.query<{ status: string }>(`select status from ingestion_runs where source_id = 'wikimedia' order by started_at desc limit 1`);
    expect(failed.rows[0]!.status).toBe("failed");

    // A writable destination: the run completes, and the saved capture replays to the same result.
    const saved = join(mkdtempSync(join(tmpdir(), "outrn-")), "capture.json");
    expect(await ingestPhotos(db, { areaSlug: "les", fetcher: relicensed, saveTo: saved })).toMatchObject({ photos: 2 });
    const after = await photos();
    expect(after.map((p) => p.venue)).toEqual(["Pitt Park", "Pitt Park"]);
    await ingestPhotos(db, { areaSlug: "les", fromFile: saved });
    expect(await photos()).toEqual(after);
    await ingestPhotos(db, { areaSlug: "les", fromFile: CAPTURE });
  });

  it("a replay that doesn't hold a request fails loudly rather than dropping photos", async () => {
    await expect(ingestPhotos(db, { areaSlug: "les", fromFile: tmp("empty.json", { outrn_capture: "wikimedia", responses: {} }) })).rejects.toThrow(/record it again with --save/);
    expect(await photos()).toHaveLength(3);
    const failed = await db.query<{ status: string }>(`select status from ingestion_runs where source_id = 'wikimedia' order by started_at desc limit 1`);
    expect(failed.rows[0]!.status).toBe("failed");
  });
});
