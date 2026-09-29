import type { AgeLimit, Evidence, NearbyParking, Option, Price, TravelMode, VenueLink } from "@outrn/contracts";
import { isMenuUrlFor, isPublicWebHost } from "@outrn/core";
import { parkingText, type NearbyParking as EngineParking } from "@outrn/engine";
import { labelOf } from "../config.js";

/** Fact values (the shapes in @outrn/core fact-values) → contract values. Shared by items and place details. */

type EvidenceClass = "published" | "observation" | "estimate";

export function evidenceOf(cls: EvidenceClass): Evidence {
  return cls === "observation" ? "reported" : cls;
}

const cents = (dollars: unknown): number | null => (typeof dollars === "number" && Number.isFinite(dollars) ? Math.round(dollars * 100) : null);

/** Same reading as the engine's price gate: no amount and not free means "paid, amount unknown". */
export function priceOf(fact: { value: unknown; evidenceClass: EvidenceClass } | undefined): Price {
  if (!fact) return { kind: "unknown" };
  const v = (fact.value ?? {}) as { free?: boolean; min?: number; max?: number; currency?: string; basis?: string; tier?: number };
  const evidence = evidenceOf(fact.evidenceClass);
  if (v.free === true) return { kind: "free", evidence };
  const currency = typeof v.currency === "string" && /^[A-Z]{3}$/.test(v.currency) ? v.currency : "USD";
  const tier = typeof v.tier === "number" && v.tier >= 1 && v.tier <= 4 ? v.tier : null;
  return { kind: "paid", minCents: cents(v.min), maxCents: cents(v.max), currency, per: v.basis === "per_group" ? "group" : "person", tier, evidence };
}

export function ageLimitFrom(fact: { value: unknown; evidenceClass: EvidenceClass } | undefined): AgeLimit | null {
  const minAge = (fact?.value as { minAge?: unknown } | undefined)?.minAge;
  if (!fact || typeof minAge !== "number" || minAge < 1) return null;
  return { minAge, evidence: evidenceOf(fact.evidenceClass) };
}

export function subtypeFrom(value: unknown): Option | null {
  const id = (value as { value?: unknown } | undefined)?.value;
  return typeof id === "string" && id ? { id, label: labelOf(id) } : null;
}

export function textFrom(value: unknown): string | null {
  const t = (value as { value?: unknown } | undefined)?.value;
  return typeof t === "string" && t.trim() ? t.trim() : null;
}

/** A website as an absolute http(s) URL, or null: the same rule the engine applies before it counts a site. */
export { websiteUrl } from "@outrn/core";

const MAPS_MODE: Record<TravelMode, string> = { walk: "walking", drive: "driving", transit: "transit" };

export function directionsUrl(point: { lat: number; lon: number }, mode: TravelMode): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${point.lat},${point.lon}`)}&travelmode=${MAPS_MODE[mode]}`;
}

/** Public parking near a place, as the contract shows it, with driving directions to the parking itself. */
export function parkingFrom(p: EngineParking | null | undefined): NearbyParking | null {
  if (!p) return null;
  return { name: p.name, kind: p.kind, fee: p.fee, openingHours: p.openingHours, location: { lat: p.point.lat, lon: p.point.lon }, distanceMetres: p.distanceM, walkMinutes: p.walkMinutes, directionsUrl: directionsUrl(p.point, "drive"), text: parkingText(p) };
}

const LINK_LABEL: Record<string, string> = { instagram: "Instagram", facebook: "Facebook", menu: "Menu" };

/**
 * The place's own pages from its links fact, in a fixed order. Only https on a public host ever
 * reaches a user, and a menu only on the place's own website or a known menu platform.
 */
export function linksFrom(value: unknown, website: string | null = null): VenueLink[] {
  const v = (value ?? {}) as Record<string, unknown>;
  const out: VenueLink[] = [];
  for (const kind of ["menu", "instagram", "facebook"]) {
    const url = v[kind];
    if (typeof url !== "string") continue;
    try {
      const u = new URL(url);
      const hostOk = kind === "menu" ? isMenuUrlFor(url, website) : isPublicWebHost(u.hostname);
      if (u.protocol === "https:" && hostOk) out.push({ kind, label: LINK_LABEL[kind]!, url });
    } catch {
      // stored values are validated on write; anything else is dropped here too
    }
  }
  return out;
}

