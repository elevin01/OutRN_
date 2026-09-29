import { readFile } from "node:fs/promises";
import { parquetMetadataAsync, parquetReadObjects, type AsyncBuffer, type FileMetaData } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { z } from "zod";
import { FetchBlocked, FetchFailed, guardedFetch } from "./fetch.js";

/**
 * Overture Maps places (docs.overturemaps.org/guides/places): an open places dataset conflated each
 * month from several providers, published as GeoParquet on a public S3 bucket. Free, no key. Only the
 * row groups whose bounding box overlaps the area are read (HTTP range requests), and only the
 * columns used here.
 *
 * Licenses fail closed: a place is kept only when it lists its sources and every one of them is
 * CDLA-Permissive-2.0 or CC0-1.0; a source without a license leaves it out. Foursquare's records
 * (Apache-2.0) are left out too, until Foursquare's NOTICE ships with the data.
 */

export const OVERTURE_BUCKET = "https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com";
const RELEASE = /^\d{4}-\d{2}-\d{2}\.\d+$/;
const PART = /^part-[A-Za-z0-9._-]+\.parquet$/;
/** The only licenses a kept place's sources may carry. */
export const OVERTURE_LICENSES = ["CDLA-Permissive-2.0", "CC0-1.0"] as const;
const ALLOWED_LICENSES: ReadonlySet<string> = new Set(OVERTURE_LICENSES);
/** Datasets left out whatever license a record claims: Foursquare's records need its NOTICE shipped with them. */
const EXCLUDED_DATASET = /foursquare/i;
/** Overture's own confidence and status-signal entries, as opposed to the datasets a place comes from. */
const INTERNAL_DATASETS = new Set(["Overture", "Overture-signals"]);
const STATUSES = ["open", "permanently_closed", "temporarily_closed"] as const;
/** Bounds on what a place carries, shared by the reader and the capture schema. */
const MAX_ID = 64;
const MAX_NAME = 256;
const MAX_CATEGORY = 64;
const MAX_URL = 2048;
const MAX_PHONE = 64;
const MAX_DATASET = 64;
const MAX_CONTACTS = 3;
const MAX_DATASETS = 16;
/** A whole metro is a few hundred thousand places; more is not a capture of one area. */
const MAX_PLACES = 500_000;
const COLUMNS = ["id", "names", "bbox", "confidence", "websites", "phones", "operating_status", "basic_category", "sources"];
/** At most this many bytes are read from the bucket per fetch: a whole city is a few hundred MB. */
const DEFAULT_MAX_BYTES = 1_500_000_000;
const MAX_LIST = 4 * 1024 * 1024;

export interface Bbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface OverturePlace {
  /** Overture's stable id (GERS). */
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** basic_category: "restaurant", "art_gallery"… */
  category: string;
  /** operating_status; null when not stated. */
  status: (typeof STATUSES)[number] | null;
  /** Confidence of Overture's own operating-status signal, when one backs the status. */
  statusSignal: number | null;
  /** When that signal was last updated (ISO). */
  statusUpdatedAt: string | null;
  /** Overture's confidence that the place exists as described, 0–1. */
  confidence: number | null;
  websites: string[];
  phones: string[];
  /** The newest update among the datasets behind the place (ISO). */
  updatedAt: string | null;
  /** Those datasets: "meta", "Microsoft", "AllThePlaces"… */
  datasets: string[];
  /** The licenses of every source behind the place: only CDLA-Permissive-2.0 and CC0-1.0. */
  licenses: string[];
}

export interface OvertureCapture {
  outrn_capture: "overture";
  release: string;
  bbox: Bbox;
  fetchedAt: string;
  places: OverturePlace[];
}

export interface OvertureFetchResult extends OvertureCapture {
  /** Row groups read, of those in the release. */
  rowGroups: { read: number; total: number };
  bytes: number;
  skipped: { outside: number; category: number; license: number; unnamed: number };
}

/** A row as the parquet reader returns it, for the columns read. */
export interface OvertureRow {
  id?: unknown;
  names?: { primary?: unknown } | null;
  bbox?: { xmin?: unknown; xmax?: unknown; ymin?: unknown; ymax?: unknown } | null;
  confidence?: unknown;
  websites?: unknown;
  phones?: unknown;
  operating_status?: unknown;
  basic_category?: unknown;
  sources?: unknown;
}

interface RowSource {
  property?: unknown;
  dataset?: unknown;
  license?: unknown;
  update_time?: unknown;
  confidence?: unknown;
}

const str = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x.trim() : null);
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
/** A share (a confidence) is 0–1; anything else is not one. */
const share = (x: unknown): number | null => {
  const n = num(x);
  return n !== null && n >= 0 && n <= 1 ? n : null;
};
const strings = (x: unknown, maxCount: number, maxLength: number): string[] =>
  Array.isArray(x) ? x.map(str).filter((s): s is string => s !== null && s.length <= maxLength).slice(0, maxCount) : [];
const iso = (x: unknown): string | null => {
  const s = str(x);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const newest = (a: string | null, b: string | null): string | null => (!a ? b : !b ? a : a > b ? a : b);

export type RowOutcome = { place: OverturePlace } | { skip: "outside" | "category" | "license" | "unnamed" };

/**
 * One parquet row → a place, if it lies in the box, has a category asked for, a name, and sources
 * that all carry an allowed license (no sources, or a source without a license, is not allowed).
 */
export function placeFromRow(row: OvertureRow, bbox: Bbox, categories: ReadonlySet<string>): RowOutcome {
  const b = row.bbox;
  const xmin = num(b?.xmin), xmax = num(b?.xmax), ymin = num(b?.ymin), ymax = num(b?.ymax);
  if (xmin === null || xmax === null || ymin === null || ymax === null) return { skip: "outside" };
  const lon = (xmin + xmax) / 2;
  const lat = (ymin + ymax) / 2;
  if (lon < bbox.west || lon > bbox.east || lat < bbox.south || lat > bbox.north) return { skip: "outside" };
  const category = str(row.basic_category);
  if (!category || category.length > MAX_CATEGORY || !categories.has(category)) return { skip: "category" };
  const id = str(row.id);
  const name = str(row.names?.primary);
  if (!id || !name || id.length > MAX_ID || name.length > MAX_NAME) return { skip: "unnamed" };
  // Fail closed: no sources means no license to go by.
  if (!Array.isArray(row.sources) || !row.sources.length) return { skip: "license" };
  const sources = row.sources as (RowSource | null | undefined)[];
  let statusSignal: number | null = null;
  let statusUpdatedAt: string | null = null;
  let updatedAt: string | null = null;
  const datasets = new Set<string>();
  const licenses = new Set<string>();
  for (const s of sources) {
    const license = str(s?.license);
    if (!s || !license || !ALLOWED_LICENSES.has(license)) return { skip: "license" };
    const dataset = str(s.dataset);
    if (dataset && EXCLUDED_DATASET.test(dataset)) return { skip: "license" };
    licenses.add(license);
    if (s.property === "/properties/operating_status") {
      const c = share(s.confidence);
      if (c !== null && (statusSignal === null || c > statusSignal)) {
        statusSignal = c;
        statusUpdatedAt = iso(s.update_time);
      }
    }
    if (dataset && !INTERNAL_DATASETS.has(dataset) && dataset.length <= MAX_DATASET) {
      datasets.add(dataset);
      updatedAt = newest(updatedAt, iso(s.update_time));
    }
  }
  const status = str(row.operating_status);
  const confidence = share(row.confidence);
  return {
    place: {
      id,
      name,
      lat: Math.round(lat * 1e6) / 1e6,
      lon: Math.round(lon * 1e6) / 1e6,
      category,
      // A status this reader does not know is no status.
      status: STATUSES.find((x) => x === status) ?? null,
      statusSignal,
      statusUpdatedAt,
      confidence: confidence === null ? null : Math.round(confidence * 1000) / 1000,
      websites: strings(row.websites, MAX_CONTACTS, MAX_URL),
      phones: strings(row.phones, MAX_CONTACTS, MAX_PHONE),
      updatedAt,
      datasets: [...datasets].sort().slice(0, MAX_DATASETS),
      licenses: [...licenses].sort(),
    },
  };
}

/** Parse an S3 ListObjectsV2 answer: common prefixes, objects, and the token for the next page. */
export function parseS3List(xml: string): { prefixes: string[]; objects: { key: string; size: number }[]; next: string | null } {
  const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const prefixes = [...xml.matchAll(/<CommonPrefixes>\s*<Prefix>([^<]*)<\/Prefix>/g)].map((m) => unescape(m[1]!));
  // Up to the next <Contents> or </Contents>: a lazy [\s\S]*? rescans the rest of an unterminated listing from every tag.
  const objects = [...xml.matchAll(/<Contents>((?:(?!<\/?Contents>)[\s\S])*)<\/Contents>/g)].flatMap((m) => {
    const key = /<Key>([^<]*)<\/Key>/.exec(m[1]!)?.[1];
    const size = Number(/<Size>(\d+)<\/Size>/.exec(m[1]!)?.[1]);
    return key && Number.isFinite(size) ? [{ key: unescape(key), size }] : [];
  });
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const next = truncated ? /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1] ?? null : null;
  return { prefixes, objects, next: next ? unescape(next) : null };
}

async function listBucket(params: Record<string, string>): Promise<ReturnType<typeof parseS3List>> {
  const out: ReturnType<typeof parseS3List> = { prefixes: [], objects: [], next: null };
  let token: string | null = null;
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams({ "list-type": "2", ...params, ...(token ? { "continuation-token": token } : {}) });
    const res = await guardedFetch(`${OVERTURE_BUCKET}/?${q}`, { sourceId: "overture", minIntervalMs: 200, maxBytes: MAX_LIST, accept: "application/xml", allowedContentTypes: ["application/xml", "text/xml"] });
    const p = parseS3List(res.text);
    out.prefixes.push(...p.prefixes);
    out.objects.push(...p.objects);
    token = p.next;
    if (!token) return out;
  }
  throw new FetchFailed("Overture bucket listing did not end after 20 pages");
}

/** The newest release on the bucket ("2026-09-23.1"). Older ones are removed after a few months. */
export async function latestOvertureRelease(): Promise<string> {
  const { prefixes } = await listBucket({ prefix: "release/", delimiter: "/" });
  const releases = prefixes.map((p) => p.replace(/^release\//, "").replace(/\/$/, "")).filter((r) => RELEASE.test(r)).sort();
  const last = releases.at(-1);
  if (!last) throw new FetchFailed("no Overture release found on the bucket");
  return last;
}

export async function listOverturePlaceFiles(release: string): Promise<{ url: string; size: number }[]> {
  if (!RELEASE.test(release)) throw new FetchBlocked(`not an Overture release name: ${release}`);
  const prefix = `release/${release}/theme=places/type=place/`;
  const { objects } = await listBucket({ prefix });
  const files = objects
    .filter((o) => o.key.startsWith(prefix) && PART.test(o.key.slice(prefix.length)) && o.size > 0)
    .map((o) => ({ url: `${OVERTURE_BUCKET}/${prefix}${o.key.slice(prefix.length)}`, size: o.size }));
  if (!files.length) throw new FetchFailed(`Overture release ${release} has no places files (releases are removed after a few months: omit --release for the newest)`);
  return files;
}

export interface Budget {
  bytes: number;
  max: number;
}

/**
 * One byte range of a file on the bucket, through the shared guard: paced with the listing, retried
 * on 429/5xx, and never more than the range: a whole file (200) or a longer reply is refused as it
 * arrives, not read first. Redirects off the bucket's host are refused there too.
 */
async function rangeGet(url: URL, start: number, end: number): Promise<ArrayBuffer> {
  const want = end - start;
  if (want <= 0) return new ArrayBuffer(0);
  const res = await guardedFetch(url.toString(), { sourceId: "overture", minIntervalMs: 200, timeoutMs: 60_000, maxBytes: want, accept: "*/*", headers: { range: `bytes=${start}-${end - 1}` } });
  if (res.status !== 206 || res.body.byteLength !== want) throw new FetchFailed(`expected ${want} bytes (206) from ${url.host}, got ${res.body.byteLength} (${res.status})`, res.status === 206 ? undefined : res.status);
  const { buffer, byteOffset, byteLength } = res.body;
  return buffer.slice(byteOffset, byteOffset + byteLength) as ArrayBuffer;
}

/** A parquet file on the bucket, read in ranges, counted against the fetch's byte budget. */
export function remoteFile(rawUrl: string, byteLength: number, budget: Budget): AsyncBuffer {
  const url = new URL(rawUrl);
  if (url.origin !== OVERTURE_BUCKET) throw new FetchBlocked(`not the Overture bucket: ${url.origin}`);
  return {
    byteLength,
    slice(start: number, end = byteLength) {
      budget.bytes += end - start;
      if (budget.bytes > budget.max) throw new FetchBlocked(`reading Overture would pass ${budget.max} bytes: ask for a smaller area`);
      return rangeGet(url, start, end);
    },
  };
}

type Stats = { min_value?: unknown; max_value?: unknown } | undefined;

/** Row ranges of the row groups whose bbox statistics overlap the box (a group without statistics is read). */
export function overlappingRowGroups(md: FileMetaData, bbox: Bbox): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let start = 0;
  for (const rg of md.row_groups) {
    const n = Number(rg.num_rows);
    const stat = (path: string): Stats => rg.columns.find((c) => c.meta_data?.path_in_schema.join(".") === path)?.meta_data?.statistics as Stats;
    const lo = (path: string) => num(stat(path)?.min_value);
    const hi = (path: string) => num(stat(path)?.max_value);
    const [xminLo, xmaxHi, yminLo, ymaxHi] = [lo("bbox.xmin"), hi("bbox.xmax"), lo("bbox.ymin"), hi("bbox.ymax")];
    const disjoint = (xminLo !== null && xminLo > bbox.east) || (xmaxHi !== null && xmaxHi < bbox.west) || (yminLo !== null && yminLo > bbox.north) || (ymaxHi !== null && ymaxHi < bbox.south);
    if (!disjoint && n > 0) out.push({ start, end: start + n });
    start += n;
  }
  return out;
}

/** Places in one parquet file (on the bucket, or any AsyncBuffer: tests read a local file). */
export async function readOverturePlaces(file: AsyncBuffer, bbox: Bbox, categories: ReadonlySet<string>, into: Pick<OvertureFetchResult, "places" | "rowGroups" | "skipped">): Promise<void> {
  const metadata = await parquetMetadataAsync(file);
  const groups = overlappingRowGroups(metadata, bbox);
  into.rowGroups.total += metadata.row_groups.length;
  into.rowGroups.read += groups.length;
  for (const g of groups) {
    const rows = (await parquetReadObjects({ file, metadata, compressors, columns: COLUMNS, rowStart: g.start, rowEnd: g.end })) as OvertureRow[];
    for (const row of rows) {
      const r = placeFromRow(row, bbox, categories);
      if ("place" in r) into.places.push(r.place);
      else into.skipped[r.skip]++;
    }
  }
}

export interface OvertureFetchOptions {
  bbox: Bbox;
  /** basic_category values to keep. */
  categories: ReadonlySet<string>;
  /** A release name; the newest when omitted. */
  release?: string;
  maxBytes?: number;
  log?: (line: string) => void;
}

export function assertBbox(b: Bbox): void {
  const ok = [b.west, b.south, b.east, b.north].every(Number.isFinite) && b.west < b.east && b.south < b.north && b.south >= -90 && b.north <= 90 && b.west >= -180 && b.east <= 180;
  // About 0.5° a side is a whole metro: anything bigger is a mistake, and a very large read.
  if (!ok || b.east - b.west > 0.5 || b.north - b.south > 0.5) throw new FetchBlocked(`not a usable bounding box: ${JSON.stringify(b)}`);
}

export async function fetchOverturePlaces(opts: OvertureFetchOptions): Promise<OvertureFetchResult> {
  assertBbox(opts.bbox);
  const log = opts.log ?? (() => undefined);
  const release = opts.release ?? (await latestOvertureRelease());
  const files = await listOverturePlaceFiles(release);
  log(`Overture ${release}: ${files.length} places files`);
  const budget: Budget = { bytes: 0, max: opts.maxBytes ?? DEFAULT_MAX_BYTES };
  const out: OvertureFetchResult = { outrn_capture: "overture", release, bbox: opts.bbox, fetchedAt: new Date().toISOString(), places: [], rowGroups: { read: 0, total: 0 }, bytes: 0, skipped: { outside: 0, category: 0, license: 0, unnamed: 0 } };
  // A few files at a time: each read is many range requests already.
  const queue = [...files];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let f = queue.shift(); f; f = queue.shift()) await readOverturePlaces(remoteFile(f.url, f.size, budget), opts.bbox, opts.categories, out);
    }),
  );
  out.bytes = budget.bytes;
  out.fetchedAt = new Date().toISOString();
  // Files are read concurrently: sort so a capture of the same release is byte-for-byte the same.
  out.places.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/** The capture as saved for replay (fixtures/live/<area>-overture.json). */
export function overtureCapture(r: OvertureCapture): OvertureCapture {
  return { outrn_capture: "overture", release: r.release, bbox: r.bbox, fetchedAt: r.fetchedAt, places: r.places };
}

/** A date as this module writes it (toISOString): a real day, so "not a date" or 31 February is refused. */
const isoDate = z.string().max(40).refine((s) => {
  const d = new Date(s);
  return !Number.isNaN(d.getTime()) && d.toISOString() === s;
}, "expected an ISO date like 2026-09-23T00:00:00.000Z");
const shareSchema = z.number().min(0).max(1);
const bounded = (max: number) => z.string().min(1).max(max).refine((s) => s.trim() === s, "expected no surrounding spaces");

const PlaceSchema = z
  .object({
    id: bounded(MAX_ID),
    name: bounded(MAX_NAME),
    lat: z.number().finite().min(-90).max(90),
    lon: z.number().finite().min(-180).max(180),
    category: bounded(MAX_CATEGORY),
    status: z.enum(STATUSES).nullable(),
    statusSignal: shareSchema.nullable(),
    statusUpdatedAt: isoDate.nullable(),
    confidence: shareSchema.nullable(),
    websites: z.array(bounded(MAX_URL)).max(MAX_CONTACTS),
    phones: z.array(bounded(MAX_PHONE)).max(MAX_CONTACTS),
    updatedAt: isoDate.nullable(),
    datasets: z.array(bounded(MAX_DATASET).refine((d) => !EXCLUDED_DATASET.test(d), "Foursquare's records are left out")).max(MAX_DATASETS),
    licenses: z.array(z.enum(OVERTURE_LICENSES)).min(1).max(OVERTURE_LICENSES.length),
  })
  .strict();

const CaptureSchema = z
  .object({
    outrn_capture: z.literal("overture"),
    release: z.string().max(40).regex(RELEASE, "expected a release name like 2026-09-23.1"),
    bbox: z
      .object({ west: z.number(), south: z.number(), east: z.number(), north: z.number() })
      .strict()
      .superRefine((b, ctx) => {
        try {
          assertBbox(b);
        } catch (e) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
        }
      }),
    fetchedAt: isoDate,
    places: z.array(PlaceSchema).max(MAX_PLACES),
  })
  .strict()
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    c.places.forEach((p, i) => {
      if (seen.has(p.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["places", i, "id"], message: `duplicate place id ${p.id}` });
      seen.add(p.id);
    });
  });

/**
 * Check a whole capture, from a file or a live read, before anything is written. Nothing is dropped:
 * a place left out would read as a place that disappeared, and its venue's claims would be retracted.
 * One bad place refuses the capture, naming the first few problems.
 */
export function parseOvertureCapture(data: unknown, what: string): OvertureCapture {
  if ((data as { outrn_capture?: unknown } | null)?.outrn_capture !== "overture") throw new Error(`${what} is not an Overture capture (outrn ingest overture --save)`);
  const r = CaptureSchema.safeParse(data);
  if (r.success) return r.data;
  const issues = r.error.issues.slice(0, 5).map((i) => `${i.path.map((k) => (typeof k === "number" ? `[${k}]` : `.${k}`)).join("").replace(/^\./, "") || "(capture)"}: ${i.message}`);
  const more = r.error.issues.length > issues.length ? ` (and ${r.error.issues.length - issues.length} more)` : "";
  throw new Error(`${what} is not a valid Overture capture, so nothing was written: ${issues.join("; ")}${more}`);
}

export async function loadOvertureCapture(path: string): Promise<OvertureCapture> {
  const raw = await readFile(path, "utf8");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${path} is not an Overture capture (outrn ingest overture --save): ${(e as Error).message}`);
  }
  return parseOvertureCapture(data, path);
}
