import { domainKey, haversineMetres, matchKey, phoneKey, type Category, type LatLon } from "@outrn/core";

// matchKey moved to @outrn/core so materialization can keep venues.name_key in step with the winning name.
export { matchKey };

/**
 * Pairwise identity scoring. Pure and unit-tested; the resolver only adds the database around it.
 *
 * Evidence weights (see plan §Identity resolution):
 *  strong     : same location-specific website/phone + matching address; explicit cross-source id
 *  supporting : normalized name, distance, category, house number
 *  negative   : different address, different category, chain branch signals, venue-within-venue
 */

export interface IdentityRecord {
  name: string;
  category: Category;
  point: LatLon;
  website: string | null;
  phone: string | null;
  housenumber: string | null;
  street: string | null;
  brand: string | null;
  /** Cross-source identifiers, e.g. { wikidata: "Q123", fsq: "abc" } */
  xids?: Record<string, string>;
}

export type Relation = "same" | "child_of" | "different";

export interface PairScore {
  score: number;
  relation: Relation;
  evidence: Record<string, number | string | boolean>;
}

export const AUTO_MERGE_THRESHOLD = 0.85;
export const REVIEW_THRESHOLD = 0.55;

const CHILD_SUFFIX = /\b(cafe|coffee|shop|store|restaurant|bar|bookshop|gift shop|kitchen|bistro|terrace|garden|theater|theatre)\b/;

function tokens(s: string): Set<string> {
  return new Set(s.split(" ").filter((w) => w.length > 1));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function scorePair(a: IdentityRecord, b: IdentityRecord): PairScore {
  const ev: PairScore["evidence"] = {};
  let score = 0;

  // Explicit cross-source identifiers settle it.
  for (const [k, v] of Object.entries(a.xids ?? {})) {
    if (b.xids?.[k] && b.xids[k] === v) {
      ev[`xid_${k}`] = true;
      return { score: 1, relation: "same", evidence: ev };
    }
  }

  const ka = matchKey(a.name);
  const kb = matchKey(b.name);
  const ta = tokens(ka);
  const tb = tokens(kb);
  const j = jaccard(ta, tb);
  ev["name_jaccard"] = +j.toFixed(2);
  const contains = ka !== kb && (ka.includes(kb) || kb.includes(ka));
  if (ka === kb) {
    score += 0.45;
    ev["name"] = "equal";
  } else if (j >= 0.6) {
    score += 0.3;
    ev["name"] = "similar";
  } else if (contains) {
    score += 0.25;
    ev["name"] = "contains";
  } else if (j >= 0.34) {
    score += 0.1;
    ev["name"] = "weak";
  }

  const d = haversineMetres(a.point, b.point);
  ev["distance_m"] = Math.round(d);
  score += d < 25 ? 0.3 : d < 75 ? 0.2 : d < 150 ? 0.1 : d < 300 ? 0 : -0.3;

  const sameCategory = a.category === b.category;
  score += sameCategory ? 0.1 : -0.25;
  ev["category"] = sameCategory ? "same" : `${a.category}/${b.category}`;

  // Shared contact details are strong unless the record looks like a chain (brand tag), in which
  // case a homepage or central phone is shared across branches and proves little.
  const chainy = Boolean(a.brand || b.brand);
  const da = domainKey(a.website);
  const db = domainKey(b.website);
  if (da && db && da === db) {
    score += chainy ? 0.05 : 0.3;
    ev["website"] = chainy ? "shared_chain_domain" : "same";
  }
  const pa = phoneKey(a.phone);
  const pb = phoneKey(b.phone);
  if (pa && pb && pa === pb) {
    score += chainy ? 0.05 : 0.25;
    ev["phone"] = chainy ? "shared_chain_phone" : "same";
  }

  // Address: decisive when both sides have one.
  if (a.housenumber && b.housenumber && a.street && b.street) {
    const same = a.housenumber === b.housenumber && matchKey(a.street) === matchKey(b.street);
    score += same ? 0.3 : -0.6;
    ev["address"] = same ? "same" : "different";
  }

  // Venue within venue: "<Parent> Café" next to "<Parent>" with a different category is a child, not a duplicate.
  if (contains && !sameCategory && d < 120) {
    const longer = ka.length > kb.length ? ka : kb;
    const extra = longer.replace(ka.length > kb.length ? kb : ka, "").trim();
    if (CHILD_SUFFIX.test(extra)) {
      ev["child_suffix"] = extra;
      return { score: Math.min(score, REVIEW_THRESHOLD - 0.01), relation: "child_of", evidence: ev };
    }
  }

  const relation: Relation = score >= AUTO_MERGE_THRESHOLD ? "same" : "different";
  return { score: +score.toFixed(3), relation, evidence: ev };
}
