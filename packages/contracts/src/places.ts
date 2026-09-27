import { z } from "zod/v4";
import { AgeLimit, IsoDateTime, LatLon, Option, Price } from "./common.js";

/** GET /v1/places/:id — what we know about one place, and how we know it. */

/**
 * Where a value came from and how fresh it is. `verifiedAt` is a real check (a call, a visit);
 * `retrievedAt` is only when we fetched the source and must never be presented as a verification.
 */
export const Provenance = z.object({
  /** Winning source first, e.g. [{ id: "founder", label: "OutRN" }]. Empty when nothing lists it. */
  sources: z.array(Option),
  evidence: z.enum(["published", "reported", "estimate", "missing"]),
  /** 0–1, or null when missing. */
  confidence: z.number().min(0).max(1).nullable(),
  verifiedAt: IsoDateTime.nullable(),
  /** When the source says it last changed (e.g. the OpenStreetMap edit). */
  sourceUpdatedAt: IsoDateTime.nullable(),
  retrievedAt: IsoDateTime.nullable(),
  /** A check older than the recheck policy (90 days): still shown, flagged as due. */
  dueForRecheck: z.boolean(),
  /** Sources disagree about this value. */
  conflict: z.boolean(),
  /** Default wording for the freshness, e.g. "confirmed Sep 26", "last edited in OSM Mar 2020". */
  freshness: z.string().nullable(),
  /** Default one-line provenance, e.g. "OutRN · confirmed Sep 26 · published". */
  summary: z.string(),
});
export type Provenance = z.infer<typeof Provenance>;

export const PlaceFact = z.object({
  /** Stable id, e.g. "opening_hours", "price", "age_limit". Open-ended. */
  attribute: z.string().min(1),
  label: z.string(),
  /** Default display value, e.g. "Mo-Su 16:00-04:00", "~$15–35 per person". */
  value: z.string(),
  /** Extra context; for hours, the state today ("Open now until 4am"). */
  detail: z.string().nullable(),
  provenance: Provenance,
});
export type PlaceFact = z.infer<typeof PlaceFact>;

export const HoursNow = z.object({
  state: z.enum(["open", "closed", "always_open", "unknown"]),
  closesAt: IsoDateTime.nullable(),
  /** The next opening, when closed. */
  opensAt: IsoDateTime.nullable(),
  /** "Open now until 4am", "Closed now · opens 11am today". */
  summary: z.string().nullable(),
});

export const PlaceDetails = z.object({
  id: z.string().min(1),
  name: z.string(),
  category: Option,
  subtype: Option.nullable(),
  timezone: z.string(),
  location: LatLon,
  address: z.string().nullable(),
  status: z.enum(["operating", "closed_temporarily", "closed_permanently", "unknown"]),
  hoursNow: HoursNow,
  price: Price,
  ageLimit: AgeLimit.nullable(),
  /** The "what we know" rows, hours first (always present, even when not listed). */
  facts: z.array(PlaceFact),
  contact: z.object({
    websiteUrl: z.url().nullable(),
    phone: z.string().nullable(),
  }),
  actions: z.object({
    directionsUrls: z.object({ walk: z.url(), transit: z.url(), drive: z.url() }),
  }),
  asOf: IsoDateTime,
  attributions: z.array(z.string()),
});
export type PlaceDetails = z.infer<typeof PlaceDetails>;
