import { describe, expect, it } from "vitest";
import { ageLimitFrom, linksFrom, priceOf, websiteUrl } from "./values.js";

describe("fact values → contract values", () => {
  it("normalizes websites to absolute http(s) URLs or drops them", () => {
    expect(websiteUrl("example.com")).toBe("https://example.com/");
    expect(websiteUrl("http://example.com/menu")).toBe("http://example.com/menu");
    expect(websiteUrl("javascript:alert(1)")).toBeNull();
    expect(websiteUrl("call us")).toBeNull();
    expect(websiteUrl(null)).toBeNull();
  });

  it("reads prices the way the engine's budget gate does, in cents", () => {
    expect(priceOf(undefined)).toEqual({ kind: "unknown" });
    expect(priceOf({ value: { free: true }, evidenceClass: "estimate" })).toEqual({ kind: "free", evidence: "estimate" });
    expect(priceOf({ value: { min: 15, max: 35.5, currency: "USD" }, evidenceClass: "published" })).toEqual({ kind: "paid", minCents: 1500, maxCents: 3550, currency: "USD", per: "person", tier: null, evidence: "published" });
    // No amount and not free: paid, amount unknown.
    expect(priceOf({ value: { unknown: true }, evidenceClass: "observation" })).toMatchObject({ kind: "paid", minCents: null, maxCents: null, evidence: "reported" });
  });

  it("drops 'all ages' (0) but keeps an estimated limit as an estimate", () => {
    expect(ageLimitFrom({ value: { minAge: 0 }, evidenceClass: "published" })).toBeNull();
    expect(ageLimitFrom({ value: { minAge: 21 }, evidenceClass: "estimate" })).toEqual({ minAge: 21, evidence: "estimate" });
  });

  it("links: only https on a public host reach a user, even from rows written before the rule", () => {
    expect(linksFrom({ menu: "https://bageldepot.example/menu", instagram: "https://www.instagram.com/bagels/" })).toEqual([
      { kind: "menu", label: "Menu", url: "https://bageldepot.example/menu" },
      { kind: "instagram", label: "Instagram", url: "https://www.instagram.com/bagels/" },
    ]);
    expect(linksFrom({ menu: "https://169.254.169.254/latest/meta-data/" })).toEqual([]);
    expect(linksFrom({ menu: "https://192.168.1.1/menu", facebook: "https://router.local/x" })).toEqual([]);
    expect(linksFrom({ menu: "https://router.lan/menu", instagram: "https://router.home/x", facebook: "https://nas.corp/x" })).toEqual([]);
  });
});

