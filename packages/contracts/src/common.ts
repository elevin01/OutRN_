import { z } from "zod/v4";

/**
 * Building blocks shared by every v1 payload.
 *
 * Two rules keep the UI and backend independent:
 * - Closed enums only for sets that are fixed by the product (travel modes, item status). Sets the
 *   backend grows over time (categories, reason codes, moods) are plain strings with a default
 *   label, so a new value never breaks a UI built against an older contract.
 * - Everything is JSON-safe: timestamps are ISO 8601 strings with an offset, money is integer
 *   cents plus an ISO 4217 currency, and "unknown" is an explicit value, never a missing field.
 */

/** An instant, e.g. "2026-10-03T22:30:00.000Z". */
export const IsoDateTime = z.iso.datetime({ offset: true });

export const TravelMode = z.enum(["walk", "transit", "drive"]);
export type TravelMode = z.infer<typeof TravelMode>;

/**
 * How a value is known. `published`: the venue or a source states it. `reported`: a visitor saw
 * it. `estimate`: inferred (a category default, a typical value). Never show an estimate as a fact.
 */
export const Evidence = z.enum(["published", "reported", "estimate"]);
export type Evidence = z.infer<typeof Evidence>;

export const LatLon = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});
export type LatLon = z.infer<typeof LatLon>;

/** A backend-defined id with its default English label. New ids can appear at any time. */
export const Option = z.object({
  id: z.string().min(1),
  label: z.string(),
});
export type Option = z.infer<typeof Option>;

/** ISO 4217, e.g. "USD". */
export const Currency = z.string().regex(/^[A-Z]{3}$/);

/** A per-person spending cap. */
export const Budget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("any") }),
  z.object({ kind: z.literal("free") }),
  z.object({ kind: z.literal("max"), maxCents: z.int().min(0), currency: Currency }),
]);
export type Budget = z.infer<typeof Budget>;

/**
 * What it costs. `paid` with both amounts null means "paid, amount unknown". Amounts are per
 * person unless `per` says group. `tier` is a 1–4 price level when the source gives one.
 */
export const Price = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("free"), evidence: Evidence }),
  z.object({
    kind: z.literal("paid"),
    minCents: z.int().min(0).nullable(),
    maxCents: z.int().min(0).nullable(),
    currency: Currency,
    per: z.enum(["person", "group"]),
    tier: z.int().min(1).max(4).nullable(),
    evidence: Evidence,
  }),
  z.object({ kind: z.literal("unknown") }),
]);
export type Price = z.infer<typeof Price>;

/**
 * A minimum age. Always shown when present, whoever is asking. An `estimate` (e.g. nightclubs are
 * usually 21+) must read as "usually 21+", never as a published rule.
 */
export const AgeLimit = z.object({
  minAge: z.int().min(1).max(25),
  evidence: Evidence,
});
export type AgeLimit = z.infer<typeof AgeLimit>;

export const NoteParam = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/**
 * A reason or caveat. `code` is stable and open-ended (e.g. "SHORT_TRAVEL", "HOURS_UNKNOWN";
 * the contracts README lists today's). `text` is the backend's default wording, lower case so it can
 * sit in a sentence; the UI may reword a code it knows and must fall back to `text` for one it does
 * not. A note with `required: true` must stay visible on the card.
 */
export const Note = z.object({
  code: z.string().min(1),
  text: z.string(),
  required: z.boolean(),
  params: z.record(z.string(), NoteParam),
});
export type Note = z.infer<typeof Note>;

/**
 * One of the place's own pages: its Instagram, Facebook, or menu. Always an https link the backend
 * rebuilt or checked. `kind` is open-ended: style the ones you know, fall back to `label`.
 */
export const VenueLink = z.object({
  kind: z.string().min(1),
  label: z.string(),
  url: z.url(),
});
export type VenueLink = z.infer<typeof VenueLink>;

/** Public parking near a place (a lot, a garage, street spaces), from OpenStreetMap. */
export const NearbyParking = z.object({
  /** "Orchard Street Lot", or null when it has no name. */
  name: z.string().nullable(),
  /** "lot" | "garage" | "street". Open-ended. */
  kind: z.string().min(1),
  /** "unknown" when the source doesn't say, or it charges only at some times: check the signs. */
  fee: z.enum(["free", "paid", "unknown"]),
  location: LatLon,
  /** Straight-line distance to the place. */
  distanceMetres: z.int().min(0),
  /** Estimated walk from the parking to the place. */
  walkMinutes: z.int().min(0),
  /** Driving directions to the parking itself. */
  directionsUrl: z.url(),
  /** Default wording: "Orchard Street Lot (paid), ~2 min walk". */
  text: z.string(),
});
export type NearbyParking = z.infer<typeof NearbyParking>;
