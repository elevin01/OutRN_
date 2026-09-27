import type { RecommendationItem, RecommendationRequest, RecommendationResponse, RecommendationsBody, ResolvedRequest } from "@outrn/contracts";
import type { Queryable, ServiceAreaRow } from "@outrn/db";
import { loadCandidates, loadPolicies, MAX_OFFSET, persistRun, pruneRuns, recommend, type Candidate, type Shortlist } from "@outrn/engine";
import { PAGE_SIZE, SNAPSHOT_RETENTION_HOURS, SNAPSHOT_TTL_MINUTES } from "../config.js";
import { ApiProblem, isUuid } from "../errors.js";
import { sourcesOf, toItem } from "../map/item.js";
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
  const generatedAt = clock();
  const snapshot: Snapshot = {
    runId: run.runId!,
    // Stored as used (origin rounded), never as received.
    request: run.request,
    resolved: run.resolved,
    area: areaOf(run.area),
    items: shortlist.ordered.map((e) => toItem(e, ctx)),
    insufficient: shortlist.fewerThanThree ? { found: shortlist.items.length, wanted: PAGE_SIZE, relaxations: shortlist.relaxations } : null,
    attributions: await attributionsFor(q, sourcesOf(shortlist.ordered)),
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

/** Another page of a search: a slice of its frozen list. Never re-runs the engine. */
export async function page(q: Queryable, cursor: string, opts: ServiceOptions = {}): Promise<RecommendationResponse> {
  const clock = opts.clock ?? (() => new Date());
  const { run, offset } = decodeCursor(cursor);
  const row = (
    await q.query<{ request: RecommendationRequest; resolved: ResolvedRequest; area: Snapshot["area"]; items: RecommendationItem[]; insufficient: Snapshot["insufficient"]; attributions: string[]; as_of: Date; generated_at: Date; expires_at: Date }>(
      `select request, resolved, area, items, insufficient, attributions, as_of, generated_at, expires_at from recommendation_snapshots where run_id = $1`,
      [run],
    )
  ).rows[0];
  if (!row) throw new ApiProblem("CURSOR_INVALID", "This search is no longer available. Start a new search.");
  if (row.expires_at <= clock()) {
    // Plans computed for an instant that has passed. Offer the same search again; keep `at` only if the user chose it.
    const { at, ...rest } = row.request;
    const restart: RecommendationRequest = row.resolved.atIsExplicit && at ? { ...rest, at } : rest;
    throw new ApiProblem("CURSOR_EXPIRED", "These results have expired. Run the search again for current options.", { restart });
  }
  return pageOf({ runId: run, request: row.request, resolved: row.resolved, area: row.area, items: row.items, insufficient: row.insufficient, attributions: row.attributions, asOf: row.as_of, generatedAt: row.generated_at, expiresAt: row.expires_at }, offset);
}

export async function recommendations(q: Queryable, body: RecommendationsBody, opts: ServiceOptions = {}): Promise<RecommendationResponse> {
  return "cursor" in body ? page(q, body.cursor, opts) : search(q, body, opts);
}
