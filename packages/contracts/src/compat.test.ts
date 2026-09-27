import { describe, expect, it } from "vitest";
import { compareSchemas, type Finding } from "../scripts/compat-lib.js";

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
    expect(run(obj({ a: str }), obj({ a: { anyOf: [str, { type: "null" }] } }), "output")).toEqual(['$.a: may now return variant type=null, which an older UI does not expect']);
  });
});
