import { contentHash, haversineMetres, isDrinkTitle, isInterest, websiteUrl, type FactInput, type Interest, type LatLon } from "@outrn/core";
import { assertSourceAllowed, audit, getArea, loadParkingRule, withTx, type Db, type Queryable } from "@outrn/db";
import { materializeSubjects, writeFacts } from "@outrn/facts";
import { eventSiteFor, matchKey } from "@outrn/identity";
import { finishRun, startRun } from "@outrn/sources";
import { z } from "zod";
import { resolveVenueRef } from "./founder.js";
import { ingestExtentFor } from "./pipeline.js";

/**
 * Events from a file: what is happening, when and where, from any source allowed to keep what it
 * gives (the founder's own list today; NYC Parks, libraries and ticketing later, each converting its
 * feed to this shape). An event is held at a venue we know (by id or name), or at a place of its
 * own: a pier for fireworks, a street fair's block. That place becomes an event site, a venue shown
 * only through its events. Everything is checked before anything is written; an event that fails a
 * check is reported and left out, the rest are written.
 *
 *   { "source": "founder", "events": [{ "id": "...", "title": "...", "start": "...", "place": {...} }] }
 */

export const EVENTS_FILE_MAX = 2000;
/** The longest an event may run: a festival weekend, a fair's week. */
export const EVENT_MAX_DAYS = 14;
/** How far ahead an event may be listed. */
export const EVENT_MAX_AHEAD_DAYS = 400;
/** An event without an end is taken to last this long, for deciding it is over. */
const DEFAULT_EVENT_HOURS = 2;

const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    // Control characters are not text: a NUL fails a whole write; the rest (C0, DEL, C1) hide what a
    // title says, and direction marks, overrides and isolates make it read as something else.
    .refine((s) => !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(s), "contains control characters");

const Place = z.union([
  z.object({ venue: text(120) }).strict(),
  z.object({ name: text(120), lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).strict(),
]);

const EventInput = z
  .object({
    /** Stable for the source: the same id updates the same event. */
    id: z.string().min(1).max(120).regex(/^[\w.:@/-]+$/, "letters, digits and . : @ / - _ only"),
    title: text(200),
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }).nullable().optional(),
    status: z.enum(["scheduled", "cancelled", "sold_out"]).optional(),
    /** The event's own page: https, a public host. */
    url: z.string().max(2000).optional(),
    /** What it is, as interest ids (live_music, festivals…). */
    kinds: z.array(z.string()).min(1).max(4).optional(),
    /** Minimum age to get in, as the event states it. */
    minAge: z.number().int().min(0).max(25).optional(),
    admission: z.enum(["walk_in", "ticket", "reservation"]).optional(),
    price: z.union([z.object({ free: z.literal(true) }).strict(), z.object({ min: z.number().min(0).max(10_000), max: z.number().min(0).max(10_000).optional(), currency: z.literal("USD") }).strict()]).optional(),
    place: Place,
    /** How this is known (the founder's own list needs it: "flyer at the pier, 10/1"). */
    evidence: text(500).optional(),
  })
  .strict();

export const EventsFile = z.object({ source: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/), events: z.array(z.unknown()).max(EVENTS_FILE_MAX) }).strict();
export type EventInput = z.infer<typeof EventInput>;

export interface EventsSummary {
  runId: string;
  source: string;
  area: string;
  events: number;
  written: number;
  sitesCreated: number;
  rejected: { index: number; id: string | null; reason: string }[];
}

/** An event's own words for an age limit: "21+", "18 +". */
const TITLE_AGE = /\b(18|21)\s?\+(?!\d)/;

interface Checked {
  index: number;
  input: EventInput;
  start: Date;
  end: Date | null;
  url: string | null;
  kinds: Interest[];
  venueId: string | null;
}

/** Everything about one event that can be checked without writing; a reason when it fails. */
async function check(q: Queryable, raw: unknown, index: number, ctx: { source: string; areaId: string; areaSlug: string; center: LatLon; radiusM: number; now: Date }): Promise<Checked | { index: number; id: string | null; reason: string }> {
  const id = raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string" ? String((raw as { id: string }).id).slice(0, 120) : null;
  const fail = (reason: string) => ({ index, id, reason });
  const parsed = EventInput.safeParse(raw);
  if (!parsed.success) return fail(parsed.error.issues.map((i) => `${i.path.join(".") || "event"}: ${i.message}`).join("; "));
  const e = parsed.data;
  if (ctx.source === "founder" && !e.evidence) return fail("evidence: say how you know about this event");
  const start = new Date(e.start);
  const end = e.end ? new Date(e.end) : null;
  if (end && end < start) return fail("end: before the start");
  if (end && end.getTime() - start.getTime() > EVENT_MAX_DAYS * 86_400_000) return fail(`end: runs more than ${EVENT_MAX_DAYS} days`);
  if (start.getTime() - ctx.now.getTime() > EVENT_MAX_AHEAD_DAYS * 86_400_000) return fail(`start: more than ${EVENT_MAX_AHEAD_DAYS} days ahead`);
  if ((end ?? new Date(start.getTime() + DEFAULT_EVENT_HOURS * 3_600_000)) < ctx.now) return fail("already over");
  const url = e.url === undefined ? null : websiteUrl(e.url);
  if (e.url !== undefined && (!url || !url.startsWith("https://"))) return fail("url: not an https link to a public site");
  const kinds = e.kinds ?? [];
  const unknown = kinds.filter((k) => !isInterest(k));
  if (unknown.length) return fail(`kinds: not interests: ${unknown.join(", ")}`);
  if (new Set(kinds).size !== kinds.length) return fail("kinds: listed twice");
  if (e.price && "max" in e.price && e.price.max !== undefined && e.price.max < e.price.min) return fail("price: max below min");
  let venueId: string | null = null;
  if ("venue" in e.place) {
    try {
      const v = await resolveVenueRef(q, e.place.venue, { areaSlug: ctx.areaSlug });
      if (v.area !== ctx.areaSlug) return fail(`place: ${v.name} is not in ${ctx.areaSlug}`);
      venueId = v.id;
    } catch (err) {
      return fail(`place: ${(err as Error).message.split("\n")[0]}`);
    }
  } else if (haversineMetres({ lat: e.place.lat, lon: e.place.lon }, ctx.center) > ctx.radiusM) {
    return fail(`place: outside ${ctx.areaSlug}`);
  }
  return { index, input: e, start, end, url, kinds: kinds as Interest[], venueId };
}

/** The facts an event states about itself, and the one age estimate a drink event at a site of its own gets. */
function eventFacts(c: Checked, occurrenceId: string, atSite: boolean, sourceId: string, runId: string, now: Date): FactInput[] {
  const e = c.input;
  const evidence = e.evidence ? `${sourceId}: ${e.evidence}` : `${sourceId} event ${e.id}`;
  const pub = (attribute: FactInput["attribute"], value: unknown, confidence: number): FactInput => ({
    subjectKind: "occurrence",
    subjectId: occurrenceId,
    attribute,
    value,
    evidenceClass: "published",
    sourceId,
    evidence,
    sourceUpdatedAt: now,
    fetchedAt: now,
    confidence,
    lineageGroup: sourceId,
    ingestionRunId: runId,
  });
  const out: FactInput[] = [];
  if (c.kinds.length) out.push(pub("event_kind", { interests: c.kinds }, 0.8));
  if (c.url) out.push(pub("website", { value: c.url }, 0.8));
  if (e.admission) out.push(pub("admission", { requirement: e.admission }, 0.8));
  if (e.price) out.push(pub("price", "free" in e.price ? { currency: "USD", free: true } : { currency: "USD", min: e.price.min, max: e.price.max ?? e.price.min }, 0.8));
  const titleAge = TITLE_AGE.exec(e.title);
  if (e.minAge !== undefined) out.push(pub("age_limit", { minAge: e.minAge }, 0.9));
  else if (titleAge) out.push({ ...pub("age_limit", { minAge: Number(titleAge[1]) }, 0.8), evidence: `title: ${JSON.stringify(e.title)}` });
  // Drink is the event: with no age stated, it is probably 21+ (the engine reads any event so, wherever
  // it is held; a site of its own keeps the estimate on record).
  else if (atSite && (isDrinkTitle(e.title) || e.kinds?.includes("drinks"))) {
    out.push({ ...pub("age_limit", { minAge: 21 }, 0.5), evidenceClass: "estimate", sourceId: "category_policy", lineageGroup: "category_policy", evidence: `drink event at a site of its own, no age stated: ${JSON.stringify(e.title)}` });
  }
  return out;
}

export interface IngestEventsOptions {
  areaSlug: string;
  now?: Date;
  actor?: string;
}

export async function ingestEvents(db: Db, file: unknown, opts: IngestEventsOptions): Promise<EventsSummary> {
  const f = EventsFile.safeParse(file);
  if (!f.success) throw new Error(`events file: ${f.error.issues.map((i) => `${i.path.join(".") || "file"}: ${i.message}`).join("; ")}`);
  const { source, events } = f.data;
  await assertSourceAllowed(db, source, "retain");
  const now = opts.now ?? new Date();
  const area = await getArea(db, opts.areaSlug);
  const { radiusM } = ingestExtentFor(area, await loadParkingRule(db, area.slug));
  const center = { lat: Number(area.lat), lon: Number(area.lon) };
  const runId = await startRun(db, { sourceId: source, areaId: area.id, kind: "events", params: { events: events.length } });
  const summary: EventsSummary = { runId, source, area: area.slug, events: events.length, written: 0, sitesCreated: 0, rejected: [] };
  try {
    const checked: Checked[] = [];
    for (const [i, raw] of events.entries()) {
      const c = await check(db, raw, i, { source, areaId: area.id, areaSlug: area.slug, center, radiusM, now });
      if ("reason" in c) summary.rejected.push(c);
      else checked.push(c);
    }
    const ids = checked.map((c) => c.input.id);
    for (const [i, id] of ids.entries()) if (ids.indexOf(id) !== i) summary.rejected.push({ index: checked[i]!.index, id, reason: "id: listed twice in this file" });
    const unique = checked.filter((c, i) => ids.indexOf(c.input.id) === i);

    await withTx(db, async (tx) => {
      const venues = new Set<string>();
      const occurrences: string[] = [];
      for (const c of unique) {
        const e = c.input;
        let venueId = c.venueId;
        const atSite = !venueId;
        if (!venueId && "name" in e.place) {
          const point = { lat: e.place.lat, lon: e.place.lon };
          // One source record per site: the same name at (nearly) the same point.
          const raw = { name: e.place.name, point };
          const se = await tx.query<{ id: string }>(
            `insert into source_entities (source_id, external_id, kind, raw, content_hash, geom, first_seen_run_id, last_seen_run_id, source_updated_at, fetched_at)
             values ($1, $2, 'venue', $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, $7, $7, $8, $8)
             on conflict (source_id, external_id) do update set last_seen_run_id = excluded.last_seen_run_id, fetched_at = excluded.fetched_at
             returning id`,
            [source, `site/${matchKey(e.place.name)}@${point.lat.toFixed(4)},${point.lon.toFixed(4)}`, JSON.stringify(raw), contentHash(raw), point.lon, point.lat, runId, now],
          );
          const site = await eventSiteFor(tx, { sourceEntityId: se.rows[0]!.id, areaId: area.id, timezone: area.timezone, record: { name: e.place.name, category: "event_site", point, website: null, phone: null, housenumber: null, street: null, brand: null, xids: {} } });
          venueId = site.venueId;
          if (site.created) summary.sitesCreated++;
          const siteFact = (attribute: FactInput["attribute"], value: unknown): FactInput => ({ subjectKind: "venue", subjectId: site.venueId, attribute, value, evidenceClass: "published", sourceId: source, evidence: `${source}: where "${e.title}" is held`, sourceUpdatedAt: now, fetchedAt: now, confidence: 0.8, lineageGroup: source, ingestionRunId: runId });
          const w = await writeFacts(tx, [siteFact("name", { value: e.place.name }), siteFact("category", { value: "event_site" }), siteFact("business_status", { status: "operating" })]);
          if (w.rejected.length) throw new Error(`site facts rejected: ${w.rejected.map((r) => `${r.attribute}: ${r.reason}`).join("; ")}`);
        }
        venues.add(venueId!);
        const occ = await tx.query<{ id: string }>(
          `insert into occurrences (venue_id, title, start_at, end_at, status, recurrence_key)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (recurrence_key) where recurrence_key is not null
           do update set venue_id = excluded.venue_id, title = excluded.title, start_at = excluded.start_at, end_at = excluded.end_at, status = excluded.status
           returning id`,
          [venueId, e.title, c.start, c.end, e.status ?? "scheduled", `${source}:${e.id}`],
        );
        const occurrenceId = occ.rows[0]!.id;
        occurrences.push(occurrenceId);
        const w = await writeFacts(tx, eventFacts(c, occurrenceId, atSite, source, runId, now));
        if (w.rejected.length) throw new Error(`event ${e.id}: facts rejected: ${w.rejected.map((r) => `${r.attribute}: ${r.reason}`).join("; ")}`);
        summary.written++;
      }
      if (occurrences.length) await materializeSubjects(tx, "occurrence", occurrences, now);
      if (venues.size) await materializeSubjects(tx, "venue", [...venues], now);
      await audit(tx, { actor: opts.actor ?? source, action: "events.ingest", targetKind: "area", targetId: area.id, after: { source, written: summary.written, sites_created: summary.sitesCreated, rejected: summary.rejected.length } });
    });
    await finishRun(db, runId, { status: summary.rejected.length && !summary.written ? "failed" : summary.rejected.length ? "partial" : "succeeded", counts: { events: summary.events, written: summary.written, sites_created: summary.sitesCreated, rejected: summary.rejected.length } });
    return summary;
  } catch (err) {
    await finishRun(db, runId, { status: "failed", error: (err as Error).message.slice(0, 500) });
    throw err;
  }
}
