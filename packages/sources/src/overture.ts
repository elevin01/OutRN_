import { readFile } from "node:fs/promises";
import { parquetMetadataAsync, parquetReadObjects, type AsyncBuffer, type FileMetaData } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { assertPublicHost, FetchBlocked, FetchFailed, guardedFetch } from "./fetch.js";

/**
 * Overture Maps places (docs.overturemaps.org/guides/places): an open places dataset conflated each
 * month from Meta, Microsoft, Foursquare, AllThePlaces and others, published as GeoParquet on a
 * public S3 bucket. Free, no key. Only the row groups whose bounding box overlaps the area are read
 * (HTTP range requests), and only the columns used here.
 *
 * Licenses: CDLA-Permissive-2.0, with Foursquare's records under Apache-2.0 and AllThePlaces' under
 * CC0. A place with any other license among its sources is left out.
 */

export const OVERTURE_BUCKET = "https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com";
const RELEASE = /^\d{4}-\d{2}-\d{2}\.\d+$/;
const PART = /^part-[A-Za-z0-9._-]+\.parquet$/;
export const OVERTURE_LICENSES: ReadonlySet<string> = new Set(["CDLA-Permissive-2.0", "Apache-2.0", "CC0-1.0"]);
/** Overture's own confidence and status-signal entries, as opposed to the datasets a place comes from. */
const INTERNAL_DATASETS = new Set(["Overture", "Overture-signals"]);
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
  /** operating_status: open, permanently_closed, temporarily_closed; null when not stated. */
  status: string | null;
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
  /** Those datasets: "meta", "Microsoft", "Foursquare"… */
  datasets: string[];
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
const strings = (x: unknown, max: number): string[] => (Array.isArray(x) ? x.map(str).filter((s): s is string => s !== null).slice(0, max) : []);
const iso = (x: unknown): string | null => {
  const s = str(x);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const newest = (a: string | null, b: string | null): string | null => (!a ? b : !b ? a : a > b ? a : b);

export type RowOutcome = { place: OverturePlace } | { skip: "outside" | "category" | "license" | "unnamed" };

/** One parquet row → a place, if it lies in the box, has a category asked for, a name, and only allowed licenses. */
export function placeFromRow(row: OvertureRow, bbox: Bbox, categories: ReadonlySet<string>): RowOutcome {
  const b = row.bbox;
  const xmin = num(b?.xmin), xmax = num(b?.xmax), ymin = num(b?.ymin), ymax = num(b?.ymax);
  if (xmin === null || xmax === null || ymin === null || ymax === null) return { skip: "outside" };
  const lon = (xmin + xmax) / 2;
  const lat = (ymin + ymax) / 2;
  if (lon < bbox.west || lon > bbox.east || lat < bbox.south || lat > bbox.north) return { skip: "outside" };
  const category = str(row.basic_category);
  if (!category || !categories.has(category)) return { skip: "category" };
  const id = str(row.id);
  const name = str(row.names?.primary);
  if (!id || !name) return { skip: "unnamed" };
  const sources = Array.isArray(row.sources) ? (row.sources as RowSource[]) : [];
  let statusSignal: number | null = null;
  let statusUpdatedAt: string | null = null;
  let updatedAt: string | null = null;
  const datasets = new Set<string>();
  for (const s of sources) {
    const license = str(s?.license);
    if (license && !OVERTURE_LICENSES.has(license)) return { skip: "license" };
    const dataset = str(s?.dataset);
    if (s?.property === "/properties/operating_status") {
      const c = num(s.confidence);
      if (c !== null && (statusSignal === null || c > statusSignal)) {
        statusSignal = c;
        statusUpdatedAt = iso(s.update_time);
      }
    }
    if (dataset && !INTERNAL_DATASETS.has(dataset)) {
      datasets.add(dataset);
      updatedAt = newest(updatedAt, iso(s?.update_time));
    }
  }
  return {
    place: {
      id,
      name,
      lat: Math.round(lat * 1e6) / 1e6,
      lon: Math.round(lon * 1e6) / 1e6,
      category,
      status: str(row.operating_status),
      statusSignal,
      statusUpdatedAt,
      confidence: num(row.confidence) === null ? null : Math.round(num(row.confidence)! * 1000) / 1000,
      websites: strings(row.websites, 3),
      phones: strings(row.phones, 3),
      updatedAt,
      datasets: [...datasets].sort(),
    },
  };
}

/** Parse an S3 ListObjectsV2 answer: common prefixes, objects, and the token for the next page. */
export function parseS3List(xml: string): { prefixes: string[]; objects: { key: string; size: number }[]; next: string | null } {
  const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const prefixes = [...xml.matchAll(/<CommonPrefixes>\s*<Prefix>([^<]*)<\/Prefix>/g)].map((m) => unescape(m[1]!));
  const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].flatMap((m) => {
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

interface Budget {
  bytes: number;
  max: number;
}

async function rangeGet(url: URL, start: number, end: number): Promise<ArrayBuffer> {
  const want = end - start;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    try {
      await assertPublicHost(url);
      const res = await fetch(url, {
        headers: { range: `bytes=${start}-${end - 1}`, "user-agent": process.env["OUTRN_USER_AGENT"] ?? "outrn-dev (set OUTRN_USER_AGENT)" },
        redirect: "error",
        signal: ctrl.signal,
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new FetchFailed(`${res.status} from ${url.host}`, res.status);
      } else if (res.status !== 206) {
        throw new FetchFailed(`expected a partial answer (206) from ${url.host}, got ${res.status}`, res.status);
      } else {
        const buf = await res.arrayBuffer();
        if (buf.byteLength !== want) throw new FetchFailed(`${url.host} answered ${buf.byteLength} bytes for a ${want}-byte range`);
        return buf;
      }
    } catch (e) {
      if (e instanceof FetchBlocked || (e instanceof FetchFailed && e.status && e.status < 500 && e.status !== 429)) throw e;
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
  }
  throw lastErr instanceof Error ? lastErr : new FetchFailed(String(lastErr));
}

/** A parquet file on the bucket, read in ranges, counted against the fetch's byte budget. */
function remoteFile(rawUrl: string, byteLength: number, budget: Budget): AsyncBuffer {
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

export async function loadOvertureCapture(path: string): Promise<OvertureCapture> {
  const data = JSON.parse(await readFile(path, "utf8")) as Partial<OvertureCapture>;
  if (data.outrn_capture !== "overture" || !Array.isArray(data.places) || typeof data.release !== "string" || !data.bbox) throw new Error(`${path} is not an Overture capture (outrn ingest overture --save)`);
  assertBbox(data.bbox);
  // A capture is a file anyone could have edited: keep only well-formed places.
  const places = (data.places as Partial<OverturePlace>[]).filter(
    (p): p is OverturePlace =>
      typeof p?.id === "string" && typeof p.name === "string" && typeof p.category === "string" && num(p.lat) !== null && num(p.lon) !== null &&
      Array.isArray(p.websites) && Array.isArray(p.phones) && Array.isArray(p.datasets),
  );
  return { outrn_capture: "overture", release: data.release, bbox: data.bbox, fetchedAt: typeof data.fetchedAt === "string" ? data.fetchedAt : new Date(0).toISOString(), places };
}
