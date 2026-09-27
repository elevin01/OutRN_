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

export async function listAreas(q: Queryable): Promise<ServiceAreaRow[]> {
  const r = await q.query<ServiceAreaRow>(
    `select id, slug, name, ST_Y(center::geometry) as lat, ST_X(center::geometry) as lon,
            radius_m, timezone, travel_mode, launch_state from service_areas order by slug`,
  );
  return r.rows;
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
