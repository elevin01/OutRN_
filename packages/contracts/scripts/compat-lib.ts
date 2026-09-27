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

function variantKey(s: Schema, i: number): string {
  const props = isObj(s["properties"]) ? (s["properties"] as Record<string, Schema>) : {};
  for (const [k, p] of Object.entries(props)) if (isObj(p) && "const" in p) return `${k}=${JSON.stringify(p["const"])}`;
  if (typeof s["type"] === "string") return `type=${s["type"]}`;
  if ("const" in s) return `const=${JSON.stringify(s["const"])}`;
  return `#${i}`;
}

export function compareSchemas(base: Schema, head: Schema, dir: Direction, path: string, out: Finding[]): void {
  const bv = variants(base);
  const hv = variants(head);
  if (bv || hv) {
    const bList = bv ?? [base];
    const hList = hv ?? [head];
    const bMap = new Map(bList.map((s, i) => [variantKey(s, i), s]));
    const hMap = new Map(hList.map((s, i) => [variantKey(s, i), s]));
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
  if ("const" in base && JSON.stringify(base["const"]) !== JSON.stringify(head["const"])) out.push({ path, message: `constant changed from ${JSON.stringify(base["const"])} to ${JSON.stringify(head["const"])}` });
  if (Array.isArray(base["enum"]) || Array.isArray(head["enum"])) {
    const b = new Set((base["enum"] as unknown[] | undefined) ?? []);
    const h = new Set((head["enum"] as unknown[] | undefined) ?? []);
    if (!Array.isArray(head["enum"]) && dir === "input") {
      // widened to any value: fine for input
    } else if (!Array.isArray(base["enum"]) && dir === "output") {
      out.push({ path, message: "now a closed enum; an older UI may receive values it cannot parse" });
    } else {
      for (const v of b) if (!h.has(v) && dir === "input") out.push({ path, message: `no longer accepts ${JSON.stringify(v)}` });
      for (const v of h) if (!b.has(v) && dir === "output") out.push({ path, message: `may now return ${JSON.stringify(v)}, which an older UI's enum rejects` });
    }
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
