import { z } from "zod";
import { guardedFetch } from "./fetch.js";

/**
 * NYC Parks' public events for the next two weeks, from NYC Open Data (dataset w3wp-dpdi, refreshed
 * daily by the Department of Parks and Recreation): free classes, tours, festivals, film nights and
 * concerts in the city's parks. One call reads the whole table (about a thousand rows); an area's own
 * events are picked from it by distance (see ingestNycParksEvents).
 */
export const NYC_PARKS_EVENTS_URL = "https://data.cityofnewyork.us/resource/w3wp-dpdi.json";
/** The table holds two weeks of the city's events, about a thousand; many more is not this table. */
const MAX_ROWS = 5000;

const Link = z.object({ url: z.string().max(4000).optional() });

/** One row as the table gives it: times are local wall-clock times, coordinates "lat, lon[; lat, lon…]". */
export const NycParksEventRow = z.object({
  guid: z.string().min(1).max(40),
  title: z.string().min(1).max(500),
  link: Link.optional(),
  description: z.string().max(20_000).optional(),
  starttime: z.string().max(40).optional(),
  endtime: z.string().max(40).optional(),
  location: z.string().max(500).optional(),
  coordinates: z.string().max(4000).optional(),
  categories: z.string().max(2000).optional(),
  parknames: z.string().max(2000).optional(),
  registration_url: Link.optional(),
  registration_description: z.string().max(4000).optional(),
});
export type NycParksEventRow = z.infer<typeof NycParksEventRow>;

/** What `ingest nyc-parks --save` writes, and a replay reads. */
export interface NycParksCapture {
  outrn_capture: "nyc-parks-events";
  dataset: "w3wp-dpdi";
  fetchedAt: string;
  rows: NycParksEventRow[];
}

const CaptureSchema = z.object({
  outrn_capture: z.literal("nyc-parks-events"),
  dataset: z.literal("w3wp-dpdi"),
  fetchedAt: z.string().datetime(),
  rows: z.array(z.unknown()).max(MAX_ROWS),
});

/** The rows of a reply that read as events; the rest are counted, not kept. */
export function parseNycParksRows(rows: readonly unknown[]): { rows: NycParksEventRow[]; unreadable: number } {
  const out: NycParksEventRow[] = [];
  let unreadable = 0;
  for (const r of rows) {
    const p = NycParksEventRow.safeParse(r);
    if (p.success) out.push(p.data);
    else unreadable++;
  }
  return { rows: out, unreadable };
}

export function parseNycParksCapture(data: unknown, label: string): NycParksCapture {
  const c = CaptureSchema.safeParse(data);
  if (!c.success) throw new Error(`${label} is not an NYC Parks events capture (outrn ingest nyc-parks --save)`);
  return { outrn_capture: "nyc-parks-events", dataset: "w3wp-dpdi", fetchedAt: c.data.fetchedAt, rows: parseNycParksRows(c.data.rows).rows };
}

export async function fetchNycParksEvents(): Promise<NycParksCapture & { unreadable: number }> {
  const res = await guardedFetch(`${NYC_PARKS_EVENTS_URL}?$limit=${MAX_ROWS}&$order=guid`, {
    sourceId: "nyc_parks",
    accept: "application/json",
    allowedContentTypes: ["application/json"],
    minIntervalMs: 2000,
    timeoutMs: 60_000,
    maxBytes: 20 * 1024 * 1024,
  });
  const body = z.array(z.unknown()).max(MAX_ROWS).parse(JSON.parse(res.text));
  const { rows, unreadable } = parseNycParksRows(body);
  return { outrn_capture: "nyc-parks-events", dataset: "w3wp-dpdi", fetchedAt: res.fetchedAt.toISOString(), rows, unreadable };
}
