import { DEFAULT_PARKING_BUFFER_MINUTES, type ParkingRule } from "@outrn/core";
import type { Queryable } from "./client.js";

export interface ServiceAreaRow {
  id: string;
  slug: string;
  name: string;
  lat: number;
  lon: number;
  radius_m: number | null;
  timezone: string;
  travel_mode: "walk" | "drive" | "transit";
  launch_state: string;
}

export async function getArea(q: Queryable, slug: string): Promise<ServiceAreaRow> {
  const r = await q.query<ServiceAreaRow>(
    `select id, slug, name, ST_Y(center::geometry) as lat, ST_X(center::geometry) as lon,
            radius_m, timezone, travel_mode, launch_state
       from service_areas where slug = $1`,
    [slug],
  );
  const row = r.rows[0];
  if (!row) throw new Error(`unknown service area: ${slug}`);
  return row;
}

/** The area with this slug, or null. */
export async function findArea(q: Queryable, slug: string): Promise<ServiceAreaRow | null> {
  const r = await q.query<ServiceAreaRow>(
    `select id, slug, name, ST_Y(center::geometry) as lat, ST_X(center::geometry) as lon,
            radius_m, timezone, travel_mode, launch_state
       from service_areas where slug = $1`,
    [slug],
  );
  return r.rows[0] ?? null;
}

export async function listAreas(q: Queryable): Promise<ServiceAreaRow[]> {
  const r = await q.query<ServiceAreaRow>(
    `select id, slug, name, ST_Y(center::geometry) as lat, ST_X(center::geometry) as lon,
            radius_m, timezone, travel_mode, launch_state from service_areas order by slug`,
  );
  return r.rows;
}

export const LAUNCH_STATES = ["test", "ingest_only", "private_beta", "live", "paused"] as const;
export type LaunchState = (typeof LAUNCH_STATES)[number];

/** States the public API serves. 'ingest_only' areas are still being filled; 'paused' ones are withdrawn. */
export const SERVED_LAUNCH_STATES: readonly LaunchState[] = ["test", "private_beta", "live"];

export function isServedArea(area: Pick<ServiceAreaRow, "launch_state">): boolean {
  return (SERVED_LAUNCH_STATES as readonly string[]).includes(area.launch_state);
}

export interface NewArea {
  slug: string;
  name: string;
  lat: number;
  lon: number;
  /** Origin catchment, metres. */
  radiusM: number;
  travelMode: ServiceAreaRow["travel_mode"];
  timezone?: string;
}

/** A new area starts 'ingest_only': fill it, check it, then launch it. */
export async function insertArea(q: Queryable, a: NewArea): Promise<ServiceAreaRow> {
  await q.query(
    `insert into service_areas (slug, name, center, radius_m, timezone, travel_mode, launch_state)
     values ($1, $2, ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography, $5, $6, $7, 'ingest_only')`,
    [a.slug, a.name, a.lat, a.lon, a.radiusM, a.timezone ?? "America/New_York", a.travelMode],
  );
  return getArea(q, a.slug);
}

export async function updateArea(q: Queryable, slug: string, changes: { name?: string; lat?: number; lon?: number; radiusM?: number; travelMode?: ServiceAreaRow["travel_mode"] }): Promise<ServiceAreaRow> {
  const current = await getArea(q, slug);
  const lat = changes.lat ?? current.lat;
  const lon = changes.lon ?? current.lon;
  await q.query(
    `update service_areas set name = $2, center = ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography, radius_m = $5, travel_mode = $6 where slug = $1`,
    [slug, changes.name ?? current.name, lat, lon, changes.radiusM ?? current.radius_m, changes.travelMode ?? current.travel_mode],
  );
  return getArea(q, slug);
}

export async function setLaunchState(q: Queryable, slug: string, state: LaunchState): Promise<ServiceAreaRow> {
  const r = await q.query(`update service_areas set launch_state = $2 where slug = $1`, [slug, state]);
  if (!r.rowCount) throw new Error(`unknown service area: ${slug}`);
  return getArea(q, slug);
}

/** Supply inside an area's ingest extent, and when it was last ingested. */
export async function areaSupply(q: Queryable, area: ServiceAreaRow, extentM: number): Promise<{ eligibleVenues: number; lastIngestAt: Date | null }> {
  const r = await q.query<{ eligible: string; last_ingest: Date | null }>(
    `select (select count(*) from venues v
              where v.publish_state = 'eligible'
                and ST_DWithin(v.geom, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4)) as eligible,
            (select max(finished_at) from ingestion_runs where area_id = $1 and status = 'succeeded') as last_ingest`,
    [area.id, area.lon, area.lat, extentM],
  );
  return { eligibleVenues: Number(r.rows[0]!.eligible), lastIngestAt: r.rows[0]!.last_ingest };
}

/** The area's parking context rule, if one applies (context_rules key parking_*, effect.applies_to.area). */
export async function loadParkingRule(q: Queryable, areaSlug: string): Promise<ParkingRule | null> {
  const r = await q.query<{ effect: { default_minutes?: number; by_hour?: { from: number; to: number; minutes: number }[] } }>(
    `select effect from context_rules
      where enabled and key like 'parking\\_%' and effect->'applies_to'->'area' ? $1
        and (active_from is null or active_from <= current_date) and (active_to is null or active_to >= current_date)
      order by version desc limit 1`,
    [areaSlug],
  );
  const e = r.rows[0]?.effect;
  if (!e) return null;
  return { defaultMinutes: e.default_minutes ?? DEFAULT_PARKING_BUFFER_MINUTES, byHour: e.by_hour ?? [] };
}

export interface SourcePolicyRow {
  id: string;
  name: string;
  allowed_ops: string[];
  retention_days: number | null;
  rate_limit: Record<string, number>;
  enabled: boolean;
  kill_switch: boolean;
  attribution: string | null;
}

export async function getSourcePolicy(q: Queryable, id: string): Promise<SourcePolicyRow> {
  const r = await q.query<SourcePolicyRow>(
    `select id, name, allowed_ops, retention_days, rate_limit, enabled, kill_switch, attribution
       from source_policies where id = $1`,
    [id],
  );
  const row = r.rows[0];
  if (!row) throw new Error(`source ${id} is not registered in source_policies`);
  return row;
}

/**
 * Gate every connector operation through the registry. Unknown permission means disabled.
 * Throws with a clear message so a misconfigured job fails loudly instead of quietly fetching.
 */
export async function assertSourceAllowed(q: Queryable, id: string, op: "fetch" | "retain" | "derive" | "display"): Promise<SourcePolicyRow> {
  const p = await getSourcePolicy(q, id);
  if (p.kill_switch) throw new Error(`source ${id}: kill switch is on`);
  if (!p.enabled) throw new Error(`source ${id}: disabled in source_policies (open conditions unresolved)`);
  if (!p.allowed_ops.includes(op)) throw new Error(`source ${id}: operation '${op}' is not permitted by its policy`);
  return p;
}

export async function audit(q: Queryable, entry: { actor: string; action: string; targetKind: string; targetId?: string | null; before?: unknown; after?: unknown }): Promise<void> {
  await q.query(
    `insert into audit_log(actor, action, target_kind, target_id, before, after) values ($1,$2,$3,$4,$5,$6)`,
    [entry.actor, entry.action, entry.targetKind, entry.targetId ?? null, entry.before === undefined ? null : JSON.stringify(entry.before), entry.after === undefined ? null : JSON.stringify(entry.after)],
  );
}

export interface CategoryPolicyRow {
  category: string;
  min_useful_minutes: number;
  admission_buffer_minutes: number;
  kitchen_close_offset_minutes: number | null;
  last_entry_default_minutes: number | null;
  activity_type: string;
  version: number;
}

export async function loadCategoryPolicies(q: Queryable): Promise<Map<string, CategoryPolicyRow>> {
  const r = await q.query<CategoryPolicyRow>("select * from category_policies");
  return new Map(r.rows.map((row) => [row.category, row]));
}
