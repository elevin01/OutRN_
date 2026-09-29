import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AsyncBuffer } from "hyparquet";
import { assertBbox, parseS3List, placeFromRow, readOverturePlaces, type Bbox, type OvertureFetchResult } from "./overture.js";

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

  it("a status without Overture's signal has none, and malformed lists are dropped", () => {
    const r = placeFromRow(row({ sources: [{ dataset: "BrightQuery", license: "CDLA-Permissive-2.0", update_time: "not a date" }], websites: "x", phones: [null, 5, "+1 212 555 0100"] }), LES, CATEGORIES);
    expect("place" in r && r.place).toMatchObject({ statusSignal: null, statusUpdatedAt: null, updatedAt: null, datasets: ["BrightQuery"], websites: [], phones: ["+1 212 555 0100"] });
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
    expect(out.places.map((p) => p.id)).toEqual(["ovt-grand", "ovt-fsq"]);
    expect(out.skipped).toEqual({ outside: 1, category: 1, license: 1, unnamed: 1 });
    expect(out.places[0]).toMatchObject({ name: "Grand Kitchen", category: "restaurant", status: "open", statusSignal: 1, websites: ["https://grandkitchen.example.com/"], datasets: ["meta"] });
    expect(out.places[0]!.lat).toBeCloseTo(40.72698, 4);
    expect(out.places[1]).toMatchObject({ name: "Broome Kitchen NYC", statusSignal: null, datasets: ["Foursquare"], phones: ["+1 (212) 555-0142"] });
    expect(reads.length).toBeGreaterThan(0);
  });
});
