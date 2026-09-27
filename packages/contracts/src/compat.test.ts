import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compareContracts, compareSchemas, type Finding } from "../scripts/compat-lib.js";

const obj = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({ type: "object", properties, required });
const str = { type: "string" };
const run = (base: object, head: object, dir: "input" | "output") => {
  const out: Finding[] = [];
  compareSchemas(base as Record<string, unknown>, head as Record<string, unknown>, dir, "$", out);
  return out.map((f) => `${f.path}: ${f.message}`);
};

describe("contract compatibility", () => {
  it("adding an optional response field or an optional request field is compatible", () => {
    expect(run(obj({ a: str }), obj({ a: str, b: str }), "output")).toEqual([]);
    expect(run(obj({ a: str }), obj({ a: str, b: str }, ["a"]), "input")).toEqual([]);
  });

  it("removing a response field or making it optional breaks the UI", () => {
    expect(run(obj({ a: str, b: str }), obj({ a: str }), "output")).toEqual(["$.b: removed from the response"]);
    expect(run(obj({ a: str }), obj({ a: str }, []), "output")).toEqual(["$.a: was always present, is now optional"]);
  });

  it("a new required request field breaks old clients", () => {
    expect(run(obj({ a: str }), obj({ a: str, b: str }), "input")).toEqual(["$.b: new required request field"]);
  });

  it("enums: a response may drop a value but not add one; a request may add but not drop", () => {
    const e = (...v: string[]) => ({ type: "string", enum: v });
    expect(run(e("x", "y"), e("x"), "output")).toEqual([]);
    expect(run(e("x"), e("x", "y"), "output")).toEqual(['$: may now return "y", which an older UI\'s enum rejects']);
    expect(run(e("x"), e("x", "y"), "input")).toEqual([]);
    expect(run(e("x", "y"), e("x"), "input")).toEqual(['$: no longer accepts "y"']);
  });

  it("union variants are matched by their discriminator", () => {
    const v = (kind: string, extra: Record<string, unknown> = {}) => obj({ kind: { type: "string", const: kind }, ...extra });
    expect(run({ anyOf: [v("free"), v("paid")] }, { anyOf: [v("free"), v("paid"), v("unknown")] }, "output")).toEqual(["$: may now return variant kind=\"unknown\", which an older UI does not expect"]);
    expect(run({ anyOf: [v("free"), v("paid", { n: str })] }, { anyOf: [v("paid"), v("free")] }, "output")).toEqual(['$<kind="paid">.n: removed from the response']);
  });

  it("a field that becomes nullable breaks readers", () => {
    expect(run(obj({ a: str }), obj({ a: { anyOf: [str, { type: "null" }] } }), "output")).toEqual(["$.a: may now return variant type=null#0, which an older UI does not expect"]);
  });

  it("a missing enum means any value, not no values", () => {
    const closed = { type: "string", enum: ["x", "y"] };
    // Response: closed → open breaks an older parser; open → closed only narrows what readers see.
    expect(run(closed, str, "output")).toEqual(['$: was limited to ["x","y"], now any value; an older UI rejects values outside that set']);
    expect(run(str, closed, "output")).toEqual([]);
    // Request: open → closed rejects requests that were valid; closed → open only widens.
    expect(run(str, closed, "input")).toEqual(['$: now accepts only ["x","y"]; requests that were valid are rejected']);
    expect(run(closed, str, "input")).toEqual([]);
  });

  it("a const is a one-value set, in both directions", () => {
    const c = { type: "string", const: "x" };
    expect(run(c, str, "output")).toEqual(['$: was limited to ["x"], now any value; an older UI rejects values outside that set']);
    expect(run(str, c, "output")).toEqual([]);
    expect(run(str, c, "input")).toEqual(['$: now accepts only ["x"]; requests that were valid are rejected']);
    expect(run(c, str, "input")).toEqual([]);
    expect(run(c, { type: "string", const: "y" }, "output")).toEqual(['$: may now return "y", which an older UI\'s enum rejects']);
  });

  it("union members without a discriminator are paired by position, so every member is compared", () => {
    const full = obj({ areaId: str, mood: str }, ["areaId"]);
    const page = obj({ cursor: str });
    const narrowed = obj({ areaId: str, mood: { type: "string", enum: ["relaxed"] } }, ["areaId"]);
    expect(run({ anyOf: [full, page] }, { anyOf: [narrowed, page] }, "input")).toEqual(['$<type=object#0>.mood: now accepts only ["relaxed"]; requests that were valid are rejected']);
    expect(run({ anyOf: [full, page] }, { anyOf: [full, page, obj({ token: str })] }, "output")).toEqual(["$: may now return variant type=object#2, which an older UI does not expect"]);
  });
});

describe("contract compatibility against the committed v1 schema", () => {
  const base = JSON.parse(readFileSync(resolve(__dirname, "../schema/v1.json"), "utf8")) as Record<string, any>;
  const item = (doc: Record<string, any>) => doc["routes"].recommendations.response.properties.items.items.properties;
  const request = (doc: Record<string, any>) => (doc["routes"].recommendations.body.anyOf as Record<string, any>[]).find((v) => v["properties"]?.mood)!;

  it("is compatible with itself", () => {
    expect(compareContracts(base, structuredClone(base))).toEqual([]);
  });

  it("flags a response enum that opens up (item status accepting any string)", () => {
    const head = structuredClone(base);
    delete item(head).status.enum;
    expect(compareContracts(base, head).map((f) => f.path)).toEqual(["recommendations.response.items[].status"]);
  });

  it("flags a request field that closes down (mood: any string → only \"relaxed\")", () => {
    const head = structuredClone(base);
    request(head).properties.mood.enum = ["relaxed"];
    const findings = compareContracts(base, head);
    expect(findings.map((f) => f.path)).toEqual(["recommendations.body<type=object#0>.mood"]);
    expect(findings[0]!.message).toContain("now accepts only");
  });

  it("allows a response field to narrow (item name becoming an enum)", () => {
    const head = structuredClone(base);
    item(head).name.enum = ["x"];
    expect(compareContracts(base, head)).toEqual([]);
  });
});
