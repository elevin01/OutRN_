import type { Candidate } from "../src/index.js";

/**
 * Exactly `target` candidates made from `base`: copies with fresh ids, nudged a few tens of metres
 * apart so they are distinct places. An empty base can never reach a target, so it is refused.
 */
export function replicate(base: readonly Candidate[], target: number): Candidate[] {
  if (base.length === 0) throw new Error("replicate: no candidates to replicate");
  const out: Candidate[] = [];
  for (let i = 0; out.length < target; i++) {
    for (const c of base) {
      if (out.length >= target) break;
      out.push({ ...c, id: `${c.id}-${i}`, venueId: `${c.venueId}-${i}`, point: { lat: c.point.lat + (i % 9) * 0.0004, lon: c.point.lon + Math.floor(i / 9) * 0.0004 } });
    }
  }
  return out;
}
