import { RecommendationRequest, RecommendationResponse, type RecommendationItem, type RecommendationsBody, type ResolvedRequest } from "@outrn/contracts";
import { findArea, type Queryable, type ServiceAreaRow } from "@outrn/db";
import { loadCandidates, loadPolicies, MAX_OFFSET, WEATHER_SOURCE, persistRun, pruneRuns, recommend, type Candidate, type Shortlist } from "@outrn/engine";
import { PAGE_SIZE, SNAPSHOT_RETENTION_HOURS, SNAPSHOT_TTL_MINUTES } from "../config.js";
import { ApiProblem, isUuid } from "../errors.js";
import { sourcesOf, toItem } from "../map/item.js";
import { loadPhotos, photoSources } from "./photos.js";
import { resolveRequest, type InternalOverrides, type ResolvedContext } from "./context.js";

export interface ServiceOptions {
  /** Wall clock; injectable so tests and fixtures are deterministic. */
  clock?: () => Date;
  overrides?: InternalOverrides;
}

export interface EngineRun extends ResolvedContext {
  candidates: Candidate[];
  shortlist: Shortlist;
  durationMs: number;
  runId: string;
}

/** Resolve, load, run the engine and record the run. Shared by the public API, ops and the CLI. */
export async function runEngine(q: Queryable, request: RecommendationRequest, opts: ServiceOptions & { persist?: boolean } = {}): Promise<Omit<EngineRun, "runId"> & { runId: string | null }> {
  const clock = opts.clock ?? (() => new Date());
  const resolved = await resolveRequest(q, request, clock(), opts.overrides);
  const { ctx, area } = resolved;
  const started = Date.now();
  const windowEnd = new Date(ctx.now.getTime() + request.windowMinutes * 60_000);
  const [candidates, policies] = await Promise.all([loadCandidates(q, ctx.origin, ctx.mode, ctx.now, windowEnd, ctx.maxTravelMinutes, ctx.parkingBufferMinutes), loadPolicies(q)]);
  const shortlist = recommend(candidates, ctx, policies, { size: PAGE_SIZE, offset: 0 });
  const durationMs = Date.now() - started;
  const runId = opts.persist === false ? null : await persistRun(q, area.id, ctx, shortlist, durationMs);
  return { ...resolved, candidates, shortlist, durationMs, runId };
}

// ---------------------------------------------------------------------------------------------
// Cursors: opaque to clients. A cursor names a frozen snapshot and an offset into it.

interface CursorData {
  run: string;
  offset: number;
}

export function encodeCursor(c: CursorData): string {
  return Buffer.from(JSON.stringify({ v: 1, r: c.run, o: c.offset })).toString("base64url");
}

export function decodeCursor(cursor: string): CursorData {
  try {
    const d = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown; r?: unknown; o?: unknown };
    if (d.v === 1 && typeof d.r === "string" && isUuid(d.r) && Number.isInteger(d.o) && (d.o as number) >= 0 && (d.o as number) <= MAX_OFFSET) return { run: d.r, offset: d.o as number };
  } catch {
    // fall through
  }
  throw new ApiProblem("CURSOR_INVALID", "This page link is not valid. Start a new search.");
}

// ---------------------------------------------------------------------------------------------

interface Snapshot {
  runId: string;
  request: RecommendationRequest;
  resolved: ResolvedRequest;
  area: RecommendationResponse["area"];
  items: RecommendationItem[];
  insufficient: RecommendationResponse["insufficient"];
  attributions: string[];
  asOf: Date;
  generatedAt: Date;
  expiresAt: Date;
}

function pageOf(s: Snapshot, offset: number): RecommendationResponse {
  const items = s.items.slice(offset, offset + PAGE_SIZE);
  const hasMore = items.length > 0 && s.items.length > offset + items.length;
  return {
    requestId: s.runId,
    asOf: s.asOf.toISOString(),
    generatedAt: s.generatedAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
    area: s.area,
    request: s.resolved,
    items,
    page: {
      offset,
      size: PAGE_SIZE,
      nextCursor: hasMore ? encodeCursor({ run: s.runId, offset: offset + items.length }) : null,
      prevCursor: offset > 0 ? encodeCursor({ run: s.runId, offset: Math.max(0, offset - PAGE_SIZE) }) : null,
    },
    insufficient: offset === 0 ? s.insufficient : null,
    attributions: s.attributions,
  };
}

export async function attributionsFor(q: Queryable, sources: string[]): Promise<string[]> {
  if (!sources.length) return [];
  const r = await q.query<{ attribution: string }>(`select distinct attribution from source_policies where id = any($1::text[]) and attribution is not null and attribution <> '' order by attribution`, [sources]);
  return r.rows.map((x) => x.attribution);
}

function areaOf(a: ServiceAreaRow): RecommendationResponse["area"] {
  return { id: a.slug, name: a.name, timezone: a.timezone };
}

/** A new search: run the engine once, freeze the whole ordered list, answer with its first page. */
export async function search(q: Queryable, request: RecommendationRequest, opts: ServiceOptions = {}): Promise<RecommendationResponse> {
  const clock = opts.clock ?? (() => new Date());
  const run = await runEngine(q, request, { ...opts, clock });
  const { shortlist, ctx } = run;
  const venueIds = [...new Set(shortlist.ordered.map((e) => e.candidate.venueId))];
  const photos = await loadPhotos(q, venueIds, 3);
  const generatedAt = clock();
  const snapshot: Snapshot = {
    runId: run.runId!,
    // Stored as used (origin rounded), never as received.
    request: run.request,
    resolved: run.resolved,
    area: areaOf(run.area),
    items: shortlist.ordered.map((e) => toItem(e, ctx, photos.get(e.candidate.venueId))),
    insufficient: shortlist.fewerThanThree ? { found: shortlist.items.length, wanted: PAGE_SIZE, relaxations: shortlist.relaxations } : null,
    // A forecast shaped the order (rain sinks parks): credit it with the facts' and photos' sources.
    attributions: await attributionsFor(q, [...sourcesOf(shortlist.ordered), ...(await photoSources(q, venueIds)), ...(ctx.weather ? [WEATHER_SOURCE] : [])]),
    asOf: ctx.now,
    generatedAt,
    expiresAt: new Date(generatedAt.getTime() + SNAPSHOT_TTL_MINUTES * 60_000),
  };
  await q.query(`delete from recommendation_snapshots where expires_at < $1`, [new Date(generatedAt.getTime() - SNAPSHOT_RETENTION_HOURS * 3_600_000)]);
  // Retention for runs, a bounded batch per search so no request pays for a backlog.
  await pruneRuns(q, generatedAt);
  await q.query(
    `insert into recommendation_snapshots (run_id, request, resolved, area, items, insufficient, attributions, as_of, generated_at, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [snapshot.runId, JSON.stringify(snapshot.request), JSON.stringify(snapshot.resolved), JSON.stringify(snapshot.area), JSON.stringify(snapshot.items), JSON.stringify(snapshot.insufficient), JSON.stringify(snapshot.attributions), snapshot.asOf, generatedAt, snapshot.expiresAt],
  );
  return pageOf(snapshot, 0);
}

/**
 * Snapshots outlive deploys: a search started before a release is paged after it. Read them through
 * the contract: upgrade the shapes earlier versions wrote, serve the page only if it then satisfies
 * today's schema, and otherwise expire the search with a restart. Stored data never causes a 500.
 * (A 1.1 page's items have no visit or plan and cannot be rebuilt without the engine: those searches
 * expire with a restart, as designed.)
 */

/**
 * Fields later versions added to items, with what an older search computed for them: none. A 1.2
 * item has no conditions; a 1.3 item names no parking; a 1.4 item has no photos; a 1.5 item lists no
 * cuisines; a 1.6 item lists no diets or features; a 1.8 item lists no interests.
 */
const ITEM_DEFAULTS: Record<string, unknown> = { conditions: [], parking: null, photos: [], cuisines: [], diets: [], features: [], interests: [] };
function upgradeItems(items: unknown): unknown {
  if (!Array.isArray(items)) return items;
  return items.map((i: unknown) => (i && typeof i === "object" ? { ...ITEM_DEFAULTS, ...i } : i));
}

async function upgradeResolved(q: Queryable, stored: unknown): Promise<unknown> {
  if (!stored || typeof stored !== "object") return stored;
  let r = stored as Record<string, unknown>;
  // Contract 1.0 had no origin or backBy: every 1.0 search planned from the area's center, with no back-by.
  if (!("origin" in r) && !("originIsDefault" in r) && !("backBy" in r) && typeof r["areaId"] === "string") {
    const area = await findArea(q, r["areaId"]);
    if (area) r = { ...r, origin: { lat: Number(area.lat), lon: Number(area.lon) }, originIsDefault: true, backBy: null };
  }
  // Before 1.2 there was no visitStyle: every search was a sit-down one.
  if (!("visitStyle" in r)) r = { ...r, visitStyle: "dine_in" };
  // Before 1.6 a search could not ask for a cuisine.
  if (!("cuisines" in r)) r = { ...r, cuisines: [] };
  // Before 1.7 it could not ask for diets or must-haves.
  if (!("diets" in r)) r = { ...r, diets: [] };
  if (!("features" in r)) r = { ...r, features: [] };
  // Before 1.8 a search had no taste.
  if (!("taste" in r)) r = { ...r, taste: [] };
  // Before 1.10 a search could not ask for events only.
  if (!("eventsOnly" in r)) r = { ...r, eventsOnly: false };
  return r;
}

/** Another page of a search: a slice of its frozen list. Never re-runs the engine. */
export async function page(q: Queryable, cursor: string, opts: ServiceOptions = {}): Promise<RecommendationResponse> {
  const clock = opts.clock ?? (() => new Date());
  const { run, offset } = decodeCursor(cursor);
  const row = (
    await q.query<{ request: unknown; resolved: unknown; area: Snapshot["area"]; items: RecommendationItem[]; insufficient: Snapshot["insufficient"]; attributions: string[]; as_of: Date; generated_at: Date; expires_at: Date }>(
      `select request, resolved, area, items, insufficient, attributions, as_of, generated_at, expires_at from recommendation_snapshots where run_id = $1`,
      [run],
    )
  ).rows[0];
  if (!row) throw new ApiProblem("CURSOR_INVALID", "This search is no longer available. Start a new search.");
  const request = RecommendationRequest.safeParse(row.request);
  if (!request.success) throw new ApiProblem("CURSOR_INVALID", "This search can no longer be continued. Start a new search.");
  // The stored request carries `at` only when the user chose it, so it restarts as the same search.
  const expire = () => new ApiProblem("CURSOR_EXPIRED", "These results have expired. Run the search again for current options.", { restart: request.data });
  if (row.expires_at <= clock()) throw expire();
  const result = pageOf(
    { runId: run, request: request.data, resolved: (await upgradeResolved(q, row.resolved)) as ResolvedRequest, area: row.area, items: upgradeItems(row.items) as RecommendationItem[], insufficient: row.insufficient, attributions: row.attributions, asOf: row.as_of, generatedAt: row.generated_at, expiresAt: row.expires_at },
    offset,
  );
  if (!RecommendationResponse.safeParse(result).success) throw expire();
  return result;
}

export async function recommendations(q: Queryable, body: RecommendationsBody, opts: ServiceOptions = {}): Promise<RecommendationResponse> {
  return "cursor" in body ? page(q, body.cursor, opts) : search(q, body, opts);
}
