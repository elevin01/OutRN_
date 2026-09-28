import { describe, expect, it } from "vitest";
import { ownValue } from "./lookup.js";

describe("ownValue", () => {
  const table: Readonly<Record<string, number>> = { mo: 1, tu: 2, zero: 0 };

  it("returns the table's own entries, falsy ones included", () => {
    expect(ownValue(table, "mo")).toBe(1);
    expect(ownValue(table, "zero")).toBe(0);
  });

  it("never returns what every object inherits", () => {
    for (const key of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf", "missing", "", null, undefined]) {
      expect(ownValue(table, key), String(key)).toBeUndefined();
    }
  });
});
