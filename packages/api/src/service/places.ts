import type { PlaceDetails, PlaceFact, Provenance, TravelMode } from "@outrn/contracts";
import { isFreshConfirmation, VERIFIED_AT_SQL } from "@outrn/core";
import type { Queryable } from "@outrn/db";
import { describeFacts, hoursToday, sourceName, type FactRecord } from "@outrn/engine";
import { evaluateHours, isHoursValue } from "@outrn/facts";
import { labelOf } from "../config.js";
import { ApiProblem, isUuid } from "../errors.js";
import { ageLimitFrom, directionsUrl, priceOf, subtypeFrom, textFrom, websiteUrl } from "../map/values.js";
import { attributionsFor } from "./recommendations.js";

interface PlaceRow {
  id: string;
  canonical_name: string;
  category: string;
  lat: number;
  lon: number;
  timezone: string;
  facts: Record<string, { value: unknown; confidence: string; evidenceClass: FactRecord["evidenceClass"]; sources: string[] | null; conflict: boolean; asOf: string | null; fetchedAt: string | null; verifiedAt: string | null }>;
  tags: Record<string, string> | null;
}

const EVIDENCE_LABEL = { published: "published", reported: "reported", estimate: "estimate", missing: "not listed" } as const;
const MODES: TravelMode[] = ["walk", "transit", "drive"];

function address(tags: Record<string, string>): string | null {
  const street = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ");
  return [street, tags["addr:city"]].filter(Boolean).join(", ") || null;
}

/**
 * Only eligible places are public, the same rule as the engine's candidate set and the anon RLS
 * policy. An excluded, suspended or not-yet-eligible venue answers 404, as an unknown id does.
 */
export async function placeDetails(q: Queryable, id: string, opts: { clock?: () => Date } = {}): Promise<PlaceDetails> {
  if (!isUuid(id)) throw new ApiProblem("NOT_FOUND", "No place with this id.");
  const now = (opts.clock ?? (() => new Date()))();
  const row = (
    await q.query<PlaceRow>(
      `select v.id, v.canonical_name, v.category,
              ST_Y(v.geom::geometry) as lat, ST_X(v.geom::geometry) as lon, v.timezone,
              coalesce((select jsonb_object_agg(cf.attribute, jsonb_build_object(
                'value', cf.value, 'confidence', cf.confidence,
                'evidenceClass', cf.evidence_class,
                'sources', cf.source_ids, 'conflict', cf.conflict,
                'asOf', (select max(coalesce(f.observed_at, f.source_updated_at)) from facts f where f.id = any(cf.input_fact_ids)),
                'fetchedAt', (select max(f.fetched_at) from facts f where f.id = any(cf.input_fact_ids)),
                'verifiedAt', ${VERIFIED_AT_SQL}))
                from current_facts cf where cf.subject_kind = 'venue' and cf.subject_id = v.id
                  and (cf.valid_until is null or cf.valid_until > $2)), '{}'::jsonb) facts,
              (select se.raw->'tags' from entity_links el join source_entities se on se.id = el.source_entity_id
                where el.venue_id = v.id and el.superseded_by is null order by el.decided_at desc limit 1) tags
         from venues v where v.id = $1 and v.publish_state = 'eligible'`,
      [id, now],
    )
  ).rows[0];
  if (!row) throw new ApiProblem("NOT_FOUND", "No place with this id.");

  const point = { lat: Number(row.lat), lon: Number(row.lon) };
  const tz = row.timezone;
  const tags = row.tags ?? {};
  const facts: Record<string, FactRecord> = Object.fromEntries(
    Object.entries(row.facts).map(([k, f]) => [
      k,
      { value: f.value, confidence: Number(f.confidence), evidenceClass: f.evidenceClass, sources: f.sources ?? [], conflict: f.conflict, asOf: f.asOf ? new Date(f.asOf) : null, fetchedAt: f.fetchedAt ? new Date(f.fetchedAt) : null, verifiedAt: f.verifiedAt ? new Date(f.verifiedAt) : null },
    ]),
  );

  const rows: PlaceFact[] = describeFacts(facts, { tz, point, now }).map((r) => {
    const f = facts[r.attribute];
    const verifiedAt = f?.verifiedAt ?? null;
    const provenance: Provenance = {
      sources: (f?.sources ?? []).map((s) => ({ id: s, label: sourceName(s) })),
      evidence: r.evidence,
      confidence: f ? f.confidence : null,
      verifiedAt: verifiedAt?.toISOString() ?? null,
      sourceUpdatedAt: f?.asOf?.toISOString() ?? null,
      retrievedAt: f?.fetchedAt?.toISOString() ?? null,
      dueForRecheck: Boolean(verifiedAt && f?.sources[0] !== "user_observation" && !isFreshConfirmation(verifiedAt, false, now)),
      conflict: r.conflict,
      freshness: r.age,
      summary: [r.source, r.age, EVIDENCE_LABEL[r.evidence]].filter(Boolean).join(" · "),
    };
    return { attribute: r.attribute, label: r.label, value: r.value, detail: r.detail, provenance };
  });

  const hours = facts["opening_hours"]?.value;
  let hoursNow: PlaceDetails["hoursNow"] = { state: "unknown", closesAt: null, opensAt: null, summary: null };
  if (isHoursValue(hours)) {
    const ev = evaluateHours(hours, now, tz, point);
    const summary = hoursToday(hours, now, tz, point);
    if (ev.parseError) hoursNow = { state: "unknown", closesAt: null, opensAt: null, summary: null };
    else if (ev.always) hoursNow = { state: "always_open", closesAt: null, opensAt: null, summary };
    else if (ev.openNow && ev.interval) hoursNow = { state: "open", closesAt: ev.interval.close.toISOString(), opensAt: null, summary };
    else hoursNow = { state: "closed", closesAt: null, opensAt: ev.interval?.open.toISOString() ?? null, summary };
  }

  const status = (facts["business_status"]?.value as { status?: string } | undefined)?.status;
  const allSources = [...new Set(Object.values(facts).flatMap((f) => f.sources))];
  return {
    id: row.id,
    name: row.canonical_name,
    category: { id: row.category, label: labelOf(row.category) },
    subtype: subtypeFrom(facts["subtype"]?.value),
    timezone: tz,
    location: point,
    address: address(tags),
    status: status === "operating" || status === "closed_temporarily" || status === "closed_permanently" ? status : "unknown",
    hoursNow,
    price: priceOf(facts["price"]),
    ageLimit: ageLimitFrom(facts["age_limit"]),
    facts: rows,
    contact: {
      websiteUrl: websiteUrl(textFrom(facts["website"]?.value) ?? tags["website"] ?? tags["contact:website"]),
      phone: textFrom(facts["phone"]?.value) ?? tags["phone"] ?? tags["contact:phone"] ?? null,
    },
    actions: { directionsUrls: Object.fromEntries(MODES.map((m) => [m, directionsUrl(point, m)])) as Record<TravelMode, string> },
    asOf: now.toISOString(),
    attributions: await attributionsFor(q, allSources),
  };
}
