import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AsyncBuffer } from "hyparquet";
import { FetchBlocked, FetchFailed } from "./fetch.js";
import { assertBbox, OVERTURE_BUCKET, parseOvertureCapture, parseS3List, placeFromRow, readOverturePlaces, remoteFile, type Bbox, type OvertureCapture, type OverturePlace, type OvertureFetchResult } from "./overture.js";

// The bucket's name resolves to a public address without asking a resolver (tests run offline).
vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "52.92.0.1", family: 4 }] }));

const LES: Bbox = { west: -74.01, south: 40.7, east: -73.97, north: 40.74 };
const CATEGORIES = new Set(["restaurant", "casual_eatery", "bar"]);
const MINI = resolve(__dirname, "../../../fixtures/overture/places-mini.parquet");

const row = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  names: { primary: "Grand Kitchen" },
  bbox: { xmin: -73.99, xmax: -73.99, ymin: 40.72, ymax: 40.72 },
  confidence: 0.912345,
  websites: ["https://grand.example.com/"],
  phones: ["2125550100"],
  operating_status: "open",
  basic_category: "restaurant",
  sources: [
    { property: "", dataset: "meta", license: "CDLA-Permissive-2.0", update_time: "2026-09-01T00:00:00Z", confidence: null },
    { property: "/properties/operating_status", dataset: "Overture-signals", license: "CDLA-Permissive-2.0", update_time: "2026-06-26T16:25:14Z", confidence: 1 },
    { property: "/properties/confidence", dataset: "Overture", license: "CDLA-Permissive-2.0", update_time: "2026-09-17T22:52:12Z", confidence: null },
  ],
  ...over,
});

describe("Overture rows", () => {
  it("keeps a named place of a wanted kind in the box, with its status signal and its datasets' newest update", () => {
    const r = placeFromRow(row(), LES, CATEGORIES);
    expect(r).toEqual({
      place: {
        id: "p1",
        name: "Grand Kitchen",
        lat: 40.72,
        lon: -73.99,
        category: "restaurant",
        status: "open",
        statusSignal: 1,
        statusUpdatedAt: "2026-06-26T16:25:14.000Z",
        confidence: 0.912,
        websites: ["https://grand.example.com/"],
        phones: ["2125550100"],
        // Overture's own confidence run is not a dataset the place comes from.
        updatedAt: "2026-09-01T00:00:00.000Z",
        datasets: ["meta"],
        licenses: ["CDLA-Permissive-2.0"],
      },
    });
  });

  it("leaves out places outside the box, of other kinds, unnamed, or under another license", () => {
    expect(placeFromRow(row({ bbox: { xmin: -73.9, xmax: -73.9, ymin: 40.8, ymax: 40.8 } }), LES, CATEGORIES)).toEqual({ skip: "outside" });
    expect(placeFromRow(row({ bbox: null }), LES, CATEGORIES)).toEqual({ skip: "outside" });
    expect(placeFromRow(row({ basic_category: "dental_clinic" }), LES, CATEGORIES)).toEqual({ skip: "category" });
    expect(placeFromRow(row({ basic_category: null }), LES, CATEGORIES)).toEqual({ skip: "category" });
    expect(placeFromRow(row({ names: null }), LES, CATEGORIES)).toEqual({ skip: "unnamed" });
    expect(placeFromRow(row({ names: { primary: "  " } }), LES, CATEGORIES)).toEqual({ skip: "unnamed" });
    const odbl = row({ sources: [{ dataset: "someone", license: "ODbL-1.0" }] });
    expect(placeFromRow(odbl, LES, CATEGORIES)).toEqual({ skip: "license" });
  });

  it("licenses fail closed: no sources, a source without a license, or any license but CDLA-Permissive-2.0 and CC0-1.0", () => {
    const meta = { property: "", dataset: "meta", license: "CDLA-Permissive-2.0", update_time: "2026-09-01T00:00:00Z" };
    const skipped = (sources: unknown) => placeFromRow(row({ sources }), LES, CATEGORIES);
    for (const sources of [[], null, undefined, "meta", [null]]) expect(skipped(sources), JSON.stringify(sources)).toEqual({ skip: "license" });
    // One source without a license is enough, even Overture's own signal entry.
    expect(skipped([meta, { dataset: "Microsoft" }])).toEqual({ skip: "license" });
    expect(skipped([meta, { dataset: "Microsoft", license: "  " }])).toEqual({ skip: "license" });
    expect(skipped([meta, { property: "/properties/operating_status", dataset: "Overture-signals", confidence: 1 }])).toEqual({ skip: "license" });
    // Foursquare's records are Apache-2.0: left out until its NOTICE ships. And whatever license one claims.
    expect(skipped([meta, { dataset: "Foursquare", license: "Apache-2.0" }])).toEqual({ skip: "license" });
    expect(skipped([{ dataset: "someone", license: "Apache-2.0" }])).toEqual({ skip: "license" });
    expect(skipped([meta, { dataset: "Foursquare", license: "CDLA-Permissive-2.0" }])).toEqual({ skip: "license" });
    const kept = skipped([meta, { dataset: "AllThePlaces", license: "CC0-1.0" }]);
    expect("place" in kept && kept.place).toMatchObject({ datasets: ["AllThePlaces", "meta"], licenses: ["CC0-1.0", "CDLA-Permissive-2.0"] });
  });

  it("a status without Overture's signal has none, and malformed lists are dropped", () => {
    const r = placeFromRow(row({ sources: [{ dataset: "BrightQuery", license: "CDLA-Permissive-2.0", update_time: "not a date" }], websites: "x", phones: [null, 5, "+1 212 555 0100"] }), LES, CATEGORIES);
    expect("place" in r && r.place).toMatchObject({ statusSignal: null, statusUpdatedAt: null, updatedAt: null, datasets: ["BrightQuery"], websites: [], phones: ["+1 212 555 0100"] });
  });

  it("what the reader keeps is what a capture may hold: unknown statuses and out-of-range shares become null", () => {
    const signal = { property: "/properties/operating_status", dataset: "Overture-signals", license: "CDLA-Permissive-2.0", update_time: "2026-06-26T16:25:14Z", confidence: 1.5 };
    const r = placeFromRow(row({ operating_status: "closed", confidence: -0.2, sources: [{ dataset: "meta", license: "CDLA-Permissive-2.0" }, signal], websites: ["x".repeat(3000), "a.example", "b.example", "c.example"] }), LES, CATEGORIES);
    expect("place" in r && r.place).toMatchObject({ status: null, confidence: null, statusSignal: null, websites: ["a.example", "b.example", "c.example"] });
    expect(placeFromRow(row({ id: "x".repeat(65) }), LES, CATEGORIES)).toEqual({ skip: "unnamed" });
    const place = "place" in r ? r.place : null;
    expect(() => parseOvertureCapture({ ...GOOD, places: [place] }, "test")).not.toThrow();
  });
});

describe("Overture bucket", () => {
  it("reads an S3 listing: release prefixes, part files and sizes, and the next page", () => {
    const xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated>
      <Contents><Key>release/2026-09-23.1/theme=places/type=place/part-00000-a.zstd.parquet</Key><Size>731000000</Size></Contents>
      <Contents><Key>release/2026-09-23.1/theme=places/type=place/_SUCCESS</Key><Size>0</Size></Contents>
      <CommonPrefixes><Prefix>release/2026-08-20.0/</Prefix></CommonPrefixes><CommonPrefixes><Prefix>release/2026-09-23.1/</Prefix></CommonPrefixes>
      <NextContinuationToken>abc&amp;def</NextContinuationToken></ListBucketResult>`;
    expect(parseS3List(xml)).toEqual({
      prefixes: ["release/2026-08-20.0/", "release/2026-09-23.1/"],
      objects: [
        { key: "release/2026-09-23.1/theme=places/type=place/part-00000-a.zstd.parquet", size: 731000000 },
        { key: "release/2026-09-23.1/theme=places/type=place/_SUCCESS", size: 0 },
      ],
      next: "abc&def",
    });
    expect(parseS3List("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>").next).toBeNull();
  });

  it("reads an unterminated listing in linear time", () => {
    const xml = "<Contents>".repeat(20_000); // 200 KB
    const t0 = performance.now();
    expect(parseS3List(xml).objects).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it("refuses a box that is not one, or is bigger than a metro", () => {
    expect(() => assertBbox(LES)).not.toThrow();
    expect(() => assertBbox({ ...LES, west: LES.east })).toThrow(/bounding box/);
    expect(() => assertBbox({ west: -75, south: 40, east: -73, north: 41 })).toThrow(/bounding box/);
    expect(() => assertBbox({ ...LES, north: Number.NaN })).toThrow(/bounding box/);
  });

  it("reads only the row groups whose bbox overlaps, from a real (zstd) Overture-shaped file", async () => {
    const bytes = await readFile(MINI);
    const reads: [number, number][] = [];
    const file: AsyncBuffer = {
      byteLength: bytes.byteLength,
      slice(start, end = bytes.byteLength) {
        reads.push([start, end]);
        return bytes.buffer.slice(bytes.byteOffset + start, bytes.byteOffset + end);
      },
    };
    const out: Pick<OvertureFetchResult, "places" | "rowGroups" | "skipped"> = { places: [], rowGroups: { read: 0, total: 0 }, skipped: { outside: 0, category: 0, license: 0, unnamed: 0 } };
    await readOverturePlaces(file, LES, CATEGORIES, out);
    // The London row group is never read.
    expect(out.rowGroups).toEqual({ read: 1, total: 2 });
    // ovt-fsq is Foursquare's (Apache-2.0) and ovt-odbl ODbL: both left out.
    expect(out.places.map((p) => p.id)).toEqual(["ovt-grand"]);
    expect(out.skipped).toEqual({ outside: 1, category: 1, license: 2, unnamed: 1 });
    expect(out.places[0]).toMatchObject({ name: "Grand Kitchen", category: "restaurant", status: "open", statusSignal: 1, websites: ["https://grandkitchen.example.com/"], phones: ["2125550100"], datasets: ["meta"], licenses: ["CDLA-Permissive-2.0"] });
    expect(out.places[0]!.lat).toBeCloseTo(40.72698, 4);
    expect(reads.length).toBeGreaterThan(0);
  });
});

describe("Overture range reads", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const FILE = `${OVERTURE_BUCKET}/release/2026-09-23.1/theme=places/type=place/part-00000-a.zstd.parquet`;
  const file = () => remoteFile(FILE, 1_000_000, { bytes: 0, max: 10_000_000 });
  const partial = (bytes: ConstructorParameters<typeof Response>[0], headers: Record<string, string> = {}) => new Response(bytes, { status: 206, headers });

  it("asks for the range, and returns exactly its bytes", async () => {
    const fetchStub = vi.fn(async (_url: URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)["range"]).toBe("bytes=10-19");
      return partial(Uint8Array.from({ length: 10 }, (_, i) => i + 10), { "content-length": "10" });
    });
    vi.stubGlobal("fetch", fetchStub);
    const buf = await file().slice(10, 20);
    expect([...new Uint8Array(buf)]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(String(fetchStub.mock.calls[0]![0])).toBe(FILE);
  });

  it("refuses the whole file, or more than the range, as it arrives and without retrying", async () => {
    for (const res of [
      () => new Response(new Uint8Array(1000), { status: 200, headers: { "content-length": "1000" } }),
      () => partial(new Uint8Array(1000), { "content-length": "1000" }),
      () => partial(new Uint8Array(1000)),
    ]) {
      const fetchStub = vi.fn(async () => res());
      vi.stubGlobal("fetch", fetchStub);
      await expect(file().slice(0, 10)).rejects.toBeInstanceOf(FetchBlocked);
      expect(fetchStub).toHaveBeenCalledTimes(1);
    }
  });

  it("refuses a short range, a 200 of the right size, and a redirect off the bucket", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => partial(new Uint8Array(5))));
    await expect(file().slice(0, 10)).rejects.toBeInstanceOf(FetchFailed);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(10), { status: 200 })));
    await expect(file().slice(0, 10)).rejects.toThrow(/expected 10 bytes \(206\)/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 307, headers: { location: "https://elsewhere.example.com/part.parquet" } })));
    await expect(file().slice(0, 10)).rejects.toBeInstanceOf(FetchBlocked);
    expect(() => remoteFile("https://elsewhere.example.com/part.parquet", 10, { bytes: 0, max: 100 })).toThrow(FetchBlocked);
  });

  it("paces range reads like the listing: files read at once still queue 200 ms apart", async () => {
    const at: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => (at.push(Date.now()), partial(new Uint8Array(10)))));
    await Promise.all([file().slice(0, 10), file().slice(10, 20), file().slice(20, 30)]);
    const gaps = at.slice(1).map((t, i) => t - at[i]!);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(195);
  });
});

const place = (over: Partial<OverturePlace> = {}): OverturePlace => ({
  id: "p1",
  name: "Grand Kitchen",
  lat: 40.72,
  lon: -73.99,
  category: "restaurant",
  status: "open",
  statusSignal: 1,
  statusUpdatedAt: "2026-06-26T16:25:14.000Z",
  confidence: 0.9,
  websites: ["https://grand.example.com/"],
  phones: ["2125550100"],
  updatedAt: "2026-09-01T00:00:00.000Z",
  datasets: ["meta"],
  licenses: ["CDLA-Permissive-2.0"],
  ...over,
});
const GOOD: OvertureCapture = { outrn_capture: "overture", release: "2026-09-23.1", bbox: LES, fetchedAt: "2026-09-29T00:00:00.000Z", places: [place(), place({ id: "p2", status: null, statusSignal: null, statusUpdatedAt: null, confidence: null, updatedAt: null })] };

describe("Overture captures", () => {
  it("a well-formed capture is read as it is, every place kept", () => {
    expect(parseOvertureCapture(JSON.parse(JSON.stringify(GOOD)), "good.json")).toEqual(GOOD);
  });

  it("one malformed place refuses the whole capture, naming it: nothing is dropped", () => {
    const bad: [string, Record<string, unknown>][] = [
      ["phones", { phones: [42] }],
      ["statusSignal", { statusSignal: "1" }],
      ["statusSignal", { statusSignal: 1.2 }],
      ["confidence", { confidence: -0.1 }],
      ["statusUpdatedAt", { statusUpdatedAt: "not a date" }],
      ["updatedAt", { updatedAt: "2026-02-31T00:00:00.000Z" }],
      ["status", { status: "closed" }],
      ["lat", { lat: "40.72" }],
      ["lat", { lat: 91 }],
      ["lon", { lon: null }],
      ["id", { id: "" }],
      ["id", { id: "x".repeat(65) }],
      ["name", { name: "n".repeat(257) }],
      ["category", { category: 7 }],
      ["websites", { websites: ["a", "b", "c", "d"] }],
      ["websites", { websites: "https://grand.example.com/" }],
      ["datasets", { datasets: ["Foursquare"] }],
      ["licenses", { licenses: [] }],
      ["licenses", { licenses: ["Apache-2.0"] }],
      ["extra", { extra: 1 }],
    ];
    for (const [field, over] of bad) {
      const c = { ...GOOD, places: [GOOD.places[0], { ...GOOD.places[1], ...over }] };
      expect(() => parseOvertureCapture(c, "bad.json"), JSON.stringify(over)).toThrow(new RegExp(`bad\\.json is not a valid Overture capture.*places\\[1\\]`));
      expect(() => parseOvertureCapture(c, "bad.json"), field).toThrow(field === "extra" ? /Unrecognized key/ : new RegExp(field));
    }
    const noLicenses: Record<string, unknown> = { ...GOOD.places[1] };
    delete noLicenses["licenses"];
    expect(() => parseOvertureCapture({ ...GOOD, places: [noLicenses] }, "old.json")).toThrow(/places\[0\]\.licenses/);
  });

  it("the capture itself: its kind, release, box, date, and one entry per place id", () => {
    expect(() => parseOvertureCapture({ elements: [] }, "osm.json")).toThrow(/osm\.json is not an Overture capture/);
    expect(() => parseOvertureCapture({ ...GOOD, release: "latest" }, "c.json")).toThrow(/release/);
    expect(() => parseOvertureCapture({ ...GOOD, bbox: { west: -75, south: 40, east: -73, north: 41 } }, "c.json")).toThrow(/bounding box/);
    expect(() => parseOvertureCapture({ ...GOOD, fetchedAt: "yesterday" }, "c.json")).toThrow(/fetchedAt/);
    expect(() => parseOvertureCapture({ ...GOOD, places: "none" }, "c.json")).toThrow(/places/);
    expect(() => parseOvertureCapture({ ...GOOD, places: [place(), place({ name: "Other" })] }, "c.json")).toThrow(/places\[1\]\.id: duplicate place id p1/);
  });
});
