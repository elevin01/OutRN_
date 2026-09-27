import { ATTRIBUTES, CATEGORIES, DYNAMIC_ATTRIBUTES, isCategory, validateFactValue, type Attribute } from "@outrn/core";
import { parseOsmHours } from "./hours.js";

/**
 * Parses what the founder types on the command line into the stored value shape for an attribute
 * (see core/evidence.ts). Strict: anything ambiguous is rejected with the accepted forms, because
 * a founder fact is published-class and outranks OSM.
 */

const ENUMS: Partial<Record<Attribute, { field: string; values: readonly string[] }>> = {
  admission: { field: "requirement", values: ["walk_in", "reservation", "reservation_available", "ticket", "tour_only"] },
  admission_status: { field: "status", values: ["confirmed", "unconfirmed", "sold_out", "cancelled"] },
  business_status: { field: "status", values: ["operating", "closed_permanently", "closed_temporarily"] },
  wheelchair: { field: "value", values: ["yes", "limited", "no"] },
  indoor_outdoor: { field: "value", values: ["indoor", "covered", "outdoor", "mixed"] },
};

export function isAttribute(x: string): x is Attribute {
  return (ATTRIBUTES as readonly string[]).includes(x);
}

/**
 * Every founder value, typed or --json, must pass the attribute's runtime schema and the founder-only
 * checks (hours that the evaluator can parse, a real http(s) website). A founder fact is published
 * class and outranks OSM, so it gets the strictest gate.
 */
function checkFounderValue(attribute: Attribute, value: unknown): unknown {
  const bad = validateFactValue(attribute, value);
  if (bad) throw new Error(`invalid ${attribute} value: ${bad}`);
  const v = value as Record<string, unknown>;
  if (attribute === "opening_hours" && typeof v["osm"] === "string" && v["osm"].trim() !== "24/7") {
    const { oh, error } = parseOsmHours(v["osm"]);
    if (!oh) throw new Error(`opening_hours must be OSM syntax, e.g. "Mo-Su 16:00-04:00" (${error})`);
  }
  if (attribute === "website") {
    let u: URL;
    try {
      u = new URL(String(v["value"]));
    } catch {
      throw new Error(`website must be a full URL, e.g. https://example.com`);
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`website must be http(s)`);
  }
  return value;
}

export function parseFounderValue(attribute: string, raw: string, opts: { json?: boolean } = {}): unknown {
  if (!isAttribute(attribute)) throw new Error(`unknown attribute '${attribute}'. One of: ${ATTRIBUTES.join(", ")}`);
  if (DYNAMIC_ATTRIBUTES.has(attribute)) throw new Error(`${attribute} changes minute to minute and can only be an observation, not a founder fact`);
  return checkFounderValue(attribute, parseText(attribute, raw, opts));
}

function parseText(attribute: Attribute, raw: string, opts: { json?: boolean }): unknown {
  const text = raw.trim();
  if (opts.json) {
    try {
      return JSON.parse(text) as unknown;
    } catch (e) {
      throw new Error(`--json value does not parse: ${(e as Error).message}`);
    }
  }
  const e = ENUMS[attribute];
  if (e) {
    const v = text.toLowerCase().replace(/[\s-]+/g, "_");
    if (!e.values.includes(v)) throw new Error(`${attribute} must be one of: ${e.values.join(", ")}`);
    return { [e.field]: v };
  }
  switch (attribute) {
    case "opening_hours": {
      if (text !== "24/7") {
        const { oh, error } = parseOsmHours(text);
        if (!oh) throw new Error(`opening_hours must be OSM syntax, e.g. "Mo-Su 16:00-04:00" (${error})`);
      }
      return { osm: text };
    }
    case "price": {
      const t = text.toLowerCase();
      if (t === "free") return { currency: "USD", free: true, basis: "per_person" };
      if (t === "paid" || t === "unknown") return { currency: "USD", basis: "per_person", unknown: true, paid: t === "paid" };
      const m = /^\$?(\d+(?:\.\d+)?)(?:\s*[-–]\s*\$?(\d+(?:\.\d+)?))?$/.exec(t);
      if (!m) throw new Error(`price must be free, paid, $12 or $10-20 (per person)`);
      const min = Number(m[1]);
      const max = m[2] === undefined ? min : Number(m[2]);
      if (max < min) throw new Error(`price range is backwards: ${text}`);
      return { min, max, currency: "USD", basis: "per_person" };
    }
    case "last_entry_offset":
    case "min_useful_minutes": {
      const m = /^(\d+)\s*(m|min|mins|minutes)?$/i.exec(text);
      if (!m) throw new Error(`${attribute} is a number of minutes, e.g. 60`);
      return { minutes: Number(m[1]) };
    }
    case "website": {
      let u: URL;
      try {
        u = new URL(text);
      } catch {
        throw new Error(`website must be a full URL, e.g. https://example.com`);
      }
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`website must be http(s)`);
      return { value: u.toString() };
    }
    case "phone":
    case "name":
      if (!text) throw new Error(`${attribute} is empty`);
      return { value: text };
    case "category":
      if (!isCategory(text)) throw new Error(`category must be one of: ${CATEGORIES.join(", ")}`);
      return { value: text };
    case "subtype": {
      const v = text.toLowerCase().replace(/[\s-]+/g, "_");
      if (!/^[a-z0-9_]{2,40}$/.test(v)) throw new Error(`subtype is a short kind name, e.g. miniature_golf`);
      return { value: v };
    }
    case "age_limit": {
      const t = text.toLowerCase().replace(/[\s-]+/g, "_");
      if (t === "all_ages" || t === "none" || t === "0") return { minAge: 0 };
      const m = /^(\d{1,2})\+?$/.exec(t);
      if (m) return { minAge: Number(m[1]) };
      throw new Error(`age_limit is a minimum age like 16+, 18+ or 21+, or "all ages" for no limit`);
    }
    case "parking": {
      const [kind, cost] = text.toLowerCase().split(/[\s,]+/);
      const kinds = ["lot", "street", "garage", "none", "unknown"];
      if (!kind || !kinds.includes(kind)) throw new Error(`parking is "<${kinds.join("|")}> [free|paid]", e.g. "lot free"`);
      if (cost && !["free", "paid"].includes(cost)) throw new Error(`parking cost must be free or paid`);
      return { kind, cost: cost ?? "unknown" };
    }
    default:
      throw new Error(`no parser for ${attribute}; pass --json with the value shape from core/evidence.ts`);
  }
}
