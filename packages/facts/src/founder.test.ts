import { describe, expect, it } from "vitest";
import { parseFounderValue } from "./founder.js";

describe("founder fact values", () => {
  it("hours must be valid OSM syntax", () => {
    expect(parseFounderValue("opening_hours", "Mo-Su 16:00-04:00")).toEqual({ osm: "Mo-Su 16:00-04:00" });
    expect(parseFounderValue("opening_hours", "24/7")).toEqual({ osm: "24/7" });
    expect(() => parseFounderValue("opening_hours", "late, ask the bartender")).toThrow(/OSM syntax/);
  });

  it("prices: free, a single amount, a range, or paid-unknown", () => {
    expect(parseFounderValue("price", "free")).toMatchObject({ free: true });
    expect(parseFounderValue("price", "$12")).toMatchObject({ min: 12, max: 12, basis: "per_person" });
    expect(parseFounderValue("price", "$10-20")).toMatchObject({ min: 10, max: 20 });
    expect(parseFounderValue("price", "paid")).toMatchObject({ unknown: true, paid: true });
    expect(() => parseFounderValue("price", "cheap")).toThrow();
  });

  it("enumerated attributes accept only their values", () => {
    expect(parseFounderValue("admission", "walk in")).toEqual({ requirement: "walk_in" });
    expect(parseFounderValue("business_status", "Closed permanently")).toEqual({ status: "closed_permanently" });
    expect(parseFounderValue("wheelchair", "limited")).toEqual({ value: "limited" });
    expect(() => parseFounderValue("admission", "sometimes")).toThrow(/walk_in/);
  });

  it("minutes, URLs, categories, parking", () => {
    expect(parseFounderValue("last_entry_offset", "45 min")).toEqual({ minutes: 45 });
    expect(parseFounderValue("website", "https://thepicturehouse.org")).toEqual({ value: "https://thepicturehouse.org/" });
    expect(() => parseFounderValue("website", "thepicturehouse.org")).toThrow(/full URL/);
    expect(parseFounderValue("category", "bowling")).toEqual({ value: "bowling" });
    expect(parseFounderValue("parking", "lot free")).toEqual({ kind: "lot", cost: "free" });
  });

  it("observation-only and unknown attributes are refused", () => {
    expect(() => parseFounderValue("queue", "none")).toThrow(/observation/);
    expect(() => parseFounderValue("vibe", "great")).toThrow(/unknown attribute/);
  });
});
