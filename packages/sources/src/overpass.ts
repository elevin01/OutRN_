import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { LatLon } from "@outrn/core";
import { guardedFetch } from "./fetch.js";
import { OSM_CATEGORY_KEYS, OSM_QUALIFIED_TAGS, OSM_TAG_CATEGORIES } from "./osm-tags.js";

/**
 * Overpass connector. Builds the category query from OSM_TAG_CATEGORIES (the same table
 * normalization maps with) and returns typed elements with a resolved point (nodes have lat/lon;
 * ways and relations come back with `center` because we ask for `out center`).
 *
 * Production never hits the free public instance; OVERPASS_URL points at our own or a
 * paid instance. Replay from a saved response is first-class so tests and offline
 * development use identical code paths.
 */

export function buildAreaQuery(center: LatLon, radiusM: number, opts: { timeoutSec?: number } = {}): string {
  const around = `(around:${Math.round(radiusM)},${center.lat.toFixed(5)},${center.lon.toFixed(5)})`;
  const clauses = [
    ...OSM_CATEGORY_KEYS.map((k) => `  nwr["name"]["${k}"~"^(${Object.keys(OSM_TAG_CATEGORIES[k]).join("|")})$"]${around};`),
    ...OSM_QUALIFIED_TAGS.map((q) => `  nwr["name"]["${q.key}"="${q.value}"]["${q.qualifierKey}"~"${q.qualifierPattern}"]${around};`),
  ].join("\n");
  return `[out:json][timeout:${opts.timeoutSec ?? 180}];\n(\n${clauses}\n);\nout center tags meta;`;
}

const TagsSchema = z.record(z.string());
const ElementSchema = z.object({
  type: z.enum(["node", "way", "relation"]),
  id: z.number(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  center: z.object({ lat: z.number(), lon: z.number() }).optional(),
  tags: TagsSchema.optional(),
  timestamp: z.string().optional(),
  version: z.number().optional(),
  changeset: z.number().optional(),
  user: z.string().optional(),
  uid: z.number().optional(),
});
export const OverpassResponseSchema = z.object({
  version: z.number().optional(),
  generator: z.string().optional(),
  osm3s: z.object({ timestamp_osm_base: z.string().optional(), copyright: z.string().optional() }).optional(),
  elements: z.array(ElementSchema),
});
export type OverpassResponse = z.infer<typeof OverpassResponseSchema>;
export type OverpassElement = z.infer<typeof ElementSchema>;

export interface OsmElement {
  externalId: string; // "node/123"
  type: "node" | "way" | "relation";
  id: number;
  point: LatLon;
  tags: Record<string, string>;
  /** OSM edit timestamp: when the SOURCE last changed this record (any field). */
  sourceUpdatedAt: Date | null;
  version: number | null;
}

export function normalizeElements(resp: OverpassResponse): { elements: OsmElement[]; baseTimestamp: Date | null; dropped: number } {
  const out: OsmElement[] = [];
  let dropped = 0;
  for (const e of resp.elements) {
    const p = e.type === "node" ? (e.lat !== undefined && e.lon !== undefined ? { lat: e.lat, lon: e.lon } : null) : e.center ?? null;
    if (!p || !e.tags || !e.tags["name"]) {
      dropped++;
      continue;
    }
    out.push({
      externalId: `${e.type}/${e.id}`,
      type: e.type,
      id: e.id,
      point: p,
      tags: e.tags,
      sourceUpdatedAt: e.timestamp ? new Date(e.timestamp) : null,
      version: e.version ?? null,
    });
  }
  const base = resp.osm3s?.timestamp_osm_base ? new Date(resp.osm3s.timestamp_osm_base) : null;
  return { elements: out, baseTimestamp: base, dropped };
}

/** The area a snapshot covers. Tombstoning is only valid inside it. */
export interface SnapshotExtent {
  lat: number;
  lon: number;
  radiusM: number;
}

export interface OverpassFetchResult {
  response: OverpassResponse;
  fetchedAt: Date;
  bytes: number;
  url: string;
  query: string;
  /** Known for live fetches, and for replays of captures saved with `outrn_extent`. */
  extent: SnapshotExtent | null;
}

/** What `ingest osm --save` writes: the Overpass response plus the extent it covers, so a replay tombstones correctly. */
export function captureWithExtent(response: OverpassResponse, extent: SnapshotExtent): unknown {
  return { ...response, outrn_extent: { lat: extent.lat, lon: extent.lon, radius_m: extent.radiusM } };
}

const CaptureExtentSchema = z.object({ outrn_extent: z.object({ lat: z.number(), lon: z.number(), radius_m: z.number() }).optional() });

export async function fetchArea(center: LatLon, radiusM: number, opts: { minIntervalMs?: number } = {}): Promise<OverpassFetchResult> {
  const url = process.env["OVERPASS_URL"] ?? "https://overpass-api.de/api/interpreter";
  const query = buildAreaQuery(center, radiusM);
  const res = await guardedFetch(url, {
    sourceId: "osm",
    method: "POST",
    body: `data=${encodeURIComponent(query)}`,
    accept: "application/json",
    allowedContentTypes: ["application/json"],
    minIntervalMs: opts.minIntervalMs ?? 2000,
    timeoutMs: 200_000, // wide drive catchments take a while on Overpass
    retries: 2,
  });
  const parsed = OverpassResponseSchema.parse(JSON.parse(res.text));
  return { response: parsed, fetchedAt: res.fetchedAt, bytes: res.bytes, url: res.url, query, extent: { lat: center.lat, lon: center.lon, radiusM } };
}

/** Replay a saved Overpass JSON response (fixtures, or a capture from a machine with network). */
export async function loadAreaFromFile(path: string): Promise<OverpassFetchResult> {
  const text = await readFile(path, "utf8");
  const json = JSON.parse(text) as unknown;
  const parsed = OverpassResponseSchema.parse(json);
  const saved = CaptureExtentSchema.parse(json).outrn_extent;
  const extent = saved ? { lat: saved.lat, lon: saved.lon, radiusM: saved.radius_m } : null;
  return { response: parsed, fetchedAt: new Date(), bytes: Buffer.byteLength(text), url: `file://${path}`, query: "(replay)", extent };
}
