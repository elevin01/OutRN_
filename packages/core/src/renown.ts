/**
 * Renown: how well known a place is as one worth going to, where Claude recognises it by name
 * (the `renown` fact; ingest's renown.ts asks). Two levels and no low one: what a model's memory
 * can do is vouch for a place people write about, not judge the ones it has never read of.
 *  - notable: recommended beyond its own block (guides, press, word of mouth across the city).
 *  - destination: people cross the city, or come to it, for this.
 */
export const RENOWN_LEVELS = ["notable", "destination"] as const;
export type RenownLevel = (typeof RENOWN_LEVELS)[number];

export function isRenownLevel(v: unknown): v is RenownLevel {
  return typeof v === "string" && (RENOWN_LEVELS as readonly string[]).includes(v);
}
