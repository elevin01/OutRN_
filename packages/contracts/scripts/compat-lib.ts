/**
 * Breaking-change detection between two versions of schema/v1.json.
 *
 * Direction matters. A request body ("input") breaks old clients when it stops accepting something
 * they send. A response ("output") breaks an old UI when it stops guaranteeing something the UI
 * reads, or starts sending a shape or enum value the UI's closed types never expected. Only
 * structure is compared (properties, required, types, enums, union variants); tightening a length
 * or range on a request is not caught and needs a reviewer's eye.
 */

type Schema = Record<string, unknown>;
type Direction = "input" | "output";

export interface Finding {
  path: string;
  message: string;
}

const isObj = (v: unknown): v is Schema => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const variants = (s: Schema): Schema[] | null => (Array.isArray(s["anyOf"]) ? (s["anyOf"] as Schema[]) : Array.isArray(s["oneOf"]) ? (s["oneOf"] as Schema[]) : null);

/**
 * Keys that pair up the members of a union across versions. A discriminated member is keyed by its
 * discriminator. Any other member is keyed by its type and its position among members of that type
 * (zod emits members in declaration order): the request body's two objects are type=object#0 and
 * type=object#1, never one collapsed key.
 */
function variantKeys(list: Schema[]): string[] {
  const seen = new Map<string, number>();
  return list.map((s) => {
    const props = isObj(s["properties"]) ? (s["properties"] as Record<string, Schema>) : {};
    for (const [k, p] of Object.entries(props)) if (isObj(p) && "const" in p) return `${k}=${JSON.stringify(p["const"])}`;
    if ("const" in s) return `const=${JSON.stringify(s["const"])}`;
    const type = typeof s["type"] === "string" ? `type=${s["type"]}` : "untyped";
    const n = seen.get(type) ?? 0;
    seen.set(type, n + 1);
    return `${type}#${n}`;
  });
}

/** The values a schema allows: its enum, its const, or null for any value of its type. */
function allowedValues(s: Schema): unknown[] | null {
  if (Array.isArray(s["enum"])) return s["enum"] as unknown[];
  if ("const" in s) return [s["const"]];
  return null;
}

export function compareSchemas(base: Schema, head: Schema, dir: Direction, path: string, out: Finding[]): void {
  const bv = variants(base);
  const hv = variants(head);
  if (bv || hv) {
    const bList = bv ?? [base];
    const hList = hv ?? [head];
    const bKeys = variantKeys(bList);
    const hKeys = variantKeys(hList);
    const bMap = new Map(bList.map((s, i) => [bKeys[i]!, s]));
    const hMap = new Map(hList.map((s, i) => [hKeys[i]!, s]));
    for (const [k, s] of bMap) {
      const h = hMap.get(k);
      if (h) compareSchemas(s, h, dir, `${path}<${k}>`, out);
      else if (dir === "input") out.push({ path, message: `no longer accepts variant ${k}` });
    }
    for (const k of hMap.keys()) if (!bMap.has(k) && dir === "output") out.push({ path, message: `may now return variant ${k}, which an older UI does not expect` });
    return;
  }
  if (base["type"] !== head["type"]) {
    out.push({ path, message: `type changed from ${JSON.stringify(base["type"])} to ${JSON.stringify(head["type"])}` });
    return;
  }
  // Value sets. No enum/const means unrestricted, never empty. A response breaks readers when it may
  // produce a value the old set excluded; a request breaks clients when it stops accepting one.
  const b = allowedValues(base);
  const h = allowedValues(head);
  const has = (set: unknown[], v: unknown) => set.some((x) => JSON.stringify(x) === JSON.stringify(v));
  if (dir === "output" && b !== null) {
    if (h === null) out.push({ path, message: `was limited to ${JSON.stringify(b)}, now any value; an older UI rejects values outside that set` });
    else for (const v of h) if (!has(b, v)) out.push({ path, message: `may now return ${JSON.stringify(v)}, which an older UI's enum rejects` });
  }
  if (dir === "input" && h !== null) {
    if (b === null) out.push({ path, message: `now accepts only ${JSON.stringify(h)}; requests that were valid are rejected` });
    else for (const v of b) if (!has(h, v)) out.push({ path, message: `no longer accepts ${JSON.stringify(v)}` });
  }
  if (isObj(base["properties"]) || isObj(head["properties"])) {
    const bp = (base["properties"] ?? {}) as Record<string, Schema>;
    const hp = (head["properties"] ?? {}) as Record<string, Schema>;
    const br = new Set((base["required"] as string[] | undefined) ?? []);
    const hr = new Set((head["required"] as string[] | undefined) ?? []);
    for (const [k, s] of Object.entries(bp)) {
      if (!(k in hp)) {
        out.push({ path: `${path}.${k}`, message: dir === "output" ? "removed from the response" : "no longer accepted in the request" });
        continue;
      }
      if (dir === "output" && br.has(k) && !hr.has(k)) out.push({ path: `${path}.${k}`, message: "was always present, is now optional" });
      if (dir === "input" && !br.has(k) && hr.has(k)) out.push({ path: `${path}.${k}`, message: "was optional, is now required" });
      compareSchemas(s, hp[k]!, dir, `${path}.${k}`, out);
    }
    for (const k of Object.keys(hp)) if (!(k in bp) && dir === "input" && hr.has(k)) out.push({ path: `${path}.${k}`, message: "new required request field" });
  }
  if (isObj(base["items"]) && isObj(head["items"])) compareSchemas(base["items"], head["items"], dir, `${path}[]`, out);
  if (isObj(base["additionalProperties"]) && isObj(head["additionalProperties"])) compareSchemas(base["additionalProperties"], head["additionalProperties"], dir, `${path}{}`, out);
}

export function compareContracts(base: Schema, head: Schema): Finding[] {
  const out: Finding[] = [];
  const br = (base["routes"] ?? {}) as Record<string, Schema>;
  const hr = (head["routes"] ?? {}) as Record<string, Schema>;
  for (const [name, b] of Object.entries(br)) {
    const h = hr[name];
    if (!h) {
      out.push({ path: name, message: "route removed" });
      continue;
    }
    if (b["method"] !== h["method"] || b["path"] !== h["path"]) out.push({ path: name, message: `moved from ${b["method"]} ${b["path"]} to ${h["method"]} ${h["path"]}` });
    if (isObj(b["body"]) && isObj(h["body"])) compareSchemas(b["body"], h["body"], "input", `${name}.body`, out);
    if (!isObj(b["body"]) && isObj(h["body"])) out.push({ path: `${name}.body`, message: "now requires a body" });
    compareSchemas(b["response"] as Schema, h["response"] as Schema, "output", `${name}.response`, out);
  }
  compareSchemas(base["error"] as Schema, head["error"] as Schema, "output", "error", out);
  return out;
}
