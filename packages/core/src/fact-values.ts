import { z } from "zod";
import { CATEGORIES } from "./categories.js";
import type { Attribute } from "./evidence.js";

/**
 * Runtime shapes for fact values, one per attribute (documented in evidence.ts). TypeScript types
 * are erased at runtime, so every write goes through validateFactValue: a malformed value from any
 * source (a connector bug, a founder's --json) is rejected at the writer instead of reaching the
 * engine. Schemas are strict: an unknown key is a typo, not an extension.
 */

const text = z.object({ value: z.string().trim().min(1).max(500) }).strict();
const oneOf = <T extends [string, ...string[]]>(values: T) => z.object({ value: z.enum(values) }).strict();
const minutes = z.object({ minutes: z.number().int().min(0).max(1440) }).strict();

const weeklyInterval = z
  .object({ weekday: z.number().int().min(0).max(6), startMin: z.number().int().min(0).max(1440), endMin: z.number().int().max(2880) })
  .strict()
  .refine((iv) => iv.endMin > iv.startMin, "interval must end after it starts");

const price = z
  .object({
    currency: z.string().length(3),
    basis: z.enum(["per_person", "per_group"]).optional(),
    free: z.boolean().optional(),
    unknown: z.boolean().optional(),
    paid: z.boolean().optional(),
    min: z.number().nonnegative().optional(),
    max: z.number().nonnegative().optional(),
    /** priceRange "$$" → 2 (first-party JSON-LD). */
    tier: z.number().int().min(1).max(4).optional(),
  })
  .strict()
  .refine((p) => p.min === undefined || p.max === undefined || p.min <= p.max, "price min is above max")
  .refine((p) => p.free === true || p.unknown === true || p.min !== undefined || p.max !== undefined, "price needs free, unknown, or an amount");

const hours = z.union([
  z.object({ osm: z.string().trim().min(1).max(1000) }).strict(),
  z.object({ weekly: z.array(weeklyInterval).min(1).max(100) }).strict(),
]);

export const FACT_VALUE_SCHEMAS = {
  name: text,
  category: z.object({ value: z.enum(CATEGORIES) }).strict(),
  opening_hours: hours,
  kitchen_hours: hours,
  last_entry_offset: minutes,
  admission: z.object({ requirement: z.enum(["walk_in", "reservation", "reservation_available", "ticket", "tour_only", "unknown"]) }).strict(),
  admission_status: z.object({ status: z.enum(["confirmed", "unconfirmed", "sold_out", "cancelled"]) }).strict(),
  price,
  min_useful_minutes: minutes,
  business_status: z.object({ status: z.enum(["operating", "closed_permanently", "closed_temporarily"]) }).strict(),
  website: text,
  phone: text,
  indoor_outdoor: oneOf(["indoor", "covered", "outdoor", "mixed"]),
  parking: z
    .object({ kind: z.enum(["lot", "street", "garage", "none", "unknown"]), cost: z.enum(["free", "paid", "unknown"]).optional(), note: z.string().max(300).optional() })
    .strict(),
  wheelchair: oneOf(["yes", "limited", "no", "unknown"]),
  subtype: z.object({ value: z.string().regex(/^[a-z0-9_]{2,40}$/, "subtype is a lowercase slug, e.g. miniature_golf") }).strict(),
  // One number, so it cannot contradict itself: 0 = no age limit, 16 = 16+, 21 = 21+.
  age_limit: z.object({ minAge: z.number().int().min(0).max(25) }).strict(),
  crowd_level: oneOf(["quiet", "moderate", "busy"]),
  queue: oneOf(["none", "short", "long"]),
  open_state: oneOf(["open", "closed"]),
} satisfies Record<Attribute, z.ZodTypeAny>;

/** null when the value has the attribute's shape; otherwise a message naming what is wrong. */
export function validateFactValue(attribute: Attribute, value: unknown): string | null {
  const schema = FACT_VALUE_SCHEMAS[attribute] as z.ZodTypeAny | undefined;
  if (!schema) return `no value schema for attribute ${attribute}`;
  const r = schema.safeParse(value);
  if (r.success) return null;
  const issue = r.error.issues[0]!;
  return `${attribute}${issue.path.length ? "." + issue.path.join(".") : ""}: ${issue.message}`;
}
