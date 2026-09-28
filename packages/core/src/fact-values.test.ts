import { describe, expect, it } from "vitest";
import { validateFactValue } from "./fact-values.js";

describe("fact value schemas", () => {
  it("accept every shape the OSM, first-party and founder paths emit", () => {
    const ok: [Parameters<typeof validateFactValue>[0], unknown][] = [
      ["name", { value: "Pete's Park Place Tavern" }],
      ["category", { value: "bowling" }],
      ["opening_hours", { osm: "Mo-Su 16:00-04:00" }],
      ["opening_hours", { weekly: [{ weekday: 5, startMin: 16 * 60, endMin: 28 * 60 }] }],
      ["business_status", { status: "operating" }],
      ["admission", { requirement: "reservation_available" }],
      ["price", { currency: "USD", free: true, basis: "per_person" }],
      ["price", { currency: "USD", basis: "per_person", unknown: true, paid: true }],
      ["price", { min: 15, max: 35, currency: "USD", basis: "per_person", tier: 2 }],
      ["price", { currency: "USD", basis: "per_person", unknown: true }],
      ["parking", { kind: "lot", cost: "free" }],
      ["wheelchair", { value: "limited" }],
      ["website", { value: "www.petesofbronxville.com" }],
      ["last_entry_offset", { minutes: 60 }],
      ["queue", { value: "short" }],
      ["age_limit", { minAge: 0 }],
      ["age_limit", { minAge: 21 }],
    ];
    for (const [attribute, value] of ok) expect(validateFactValue(attribute, value), `${attribute} ${JSON.stringify(value)}`).toBeNull();
  });

  it("reject malformed values with a message naming the problem", () => {
    expect(validateFactValue("business_status", {})).toMatch(/^business_status\.status/);
    expect(validateFactValue("business_status", { status: "open-ish" })).toMatch(/business_status\.status/);
    expect(validateFactValue("business_status", { stauts: "operating" })).not.toBeNull(); // typo'd key
    expect(validateFactValue("admission", { requirement: "sometimes" })).not.toBeNull();
    expect(validateFactValue("last_entry_offset", { minutes: -5 })).not.toBeNull();
    expect(validateFactValue("price", { min: 40, max: 20, currency: "USD" })).toMatch(/min is above max/);
    expect(validateFactValue("price", { currency: "USD" })).toMatch(/free, unknown, or an amount/);
    expect(validateFactValue("opening_hours", { weekly: [{ weekday: 7, startMin: 0, endMin: 60 }] })).not.toBeNull();
    expect(validateFactValue("opening_hours", { weekly: [{ weekday: 1, startMin: 600, endMin: 500 }] })).toMatch(/end after it starts/);
    expect(validateFactValue("opening_hours", "Mo-Su 10:00-22:00")).not.toBeNull(); // bare string, not { osm }
    expect(validateFactValue("category", { value: "casino" })).not.toBeNull();
    expect(validateFactValue("parking", { kind: "multi-storey" })).not.toBeNull();
    expect(validateFactValue("age_limit", { value: "all_ages", minAge: 21 })).not.toBeNull(); // the old, contradiction-prone shape
    expect(validateFactValue("age_limit", { minAge: -1 })).not.toBeNull();
    expect(validateFactValue("age_limit", {})).not.toBeNull();
  });

  it("links: https on a public host only, at the write boundary too", () => {
    expect(validateFactValue("links", { menu: "https://bageldepot.example/menu" })).toBeNull();
    for (const menu of ["https://169.254.169.254/", "https://[::1]/", "https://router.local/menu", "http://bageldepot.example/menu"]) {
      expect(validateFactValue("links", { menu }), menu).not.toBeNull();
    }
  });
});

