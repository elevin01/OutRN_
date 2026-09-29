import { describe, expect, it } from "vitest";
import { ageLimitFrom, linksFrom, priceOf, websiteUrl } from "./values.js";

describe("fact values → contract values", () => {
  it("normalizes websites to absolute http(s) URLs or drops them", () => {
    expect(websiteUrl("example.com")).toBe("https://example.com/");
    expect(websiteUrl("http://example.com/menu")).toBe("http://example.com/menu");
    expect(websiteUrl("javascript:alert(1)")).toBeNull();
    expect(websiteUrl("call us")).toBeNull();
    expect(websiteUrl(null)).toBeNull();
    // An OSM edit must not turn "Visit website" into a link to the user's router or a metadata address.
    for (const local of ["http://192.168.1.1/", "https://169.254.169.254/latest/meta-data/", "http://[::1]:8080/", "http://localhost/", "http://router.local/", "http://2130706433/"]) {
      expect(websiteUrl(local), local).toBeNull();
    }
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

  it("links: only https on a public host reach a user, and a menu only on the place's own site or a menu platform, even from rows written before the rules", () => {
    expect(linksFrom({ menu: "https://bageldepot.example/menu", instagram: "https://www.instagram.com/bagels/" }, "https://www.bageldepot.example/")).toEqual([
      { kind: "menu", label: "Menu", url: "https://bageldepot.example/menu" },
      { kind: "instagram", label: "Instagram", url: "https://www.instagram.com/bagels/" },
    ]);
    // A menu stored before the rule, on another site than the place's own, or with no site to compare: dropped.
    expect(linksFrom({ menu: "https://evil.example/menu" }, "https://bageldepot.example/")).toEqual([]);
    expect(linksFrom({ menu: "https://bageldepot.example/menu" })).toEqual([]);
    // A free site builder, and another tenant of a host the website shares by path.
    expect(linksFrom({ menu: "https://bagel-depot-order.square.site/" }, "https://bageldepot.example/")).toEqual([]);
    expect(linksFrom({ menu: "https://www.facebook.com/SomeoneElsesPage" }, "https://www.facebook.com/bageldepot")).toEqual([]);
    expect(linksFrom({ menu: "https://www.facebook.com/bageldepot/menu" }, "https://www.facebook.com/bageldepot")).toEqual([{ kind: "menu", label: "Menu", url: "https://www.facebook.com/bageldepot/menu" }]);
    expect(linksFrom({ menu: "https://www.toasttab.com/bagel-depot" })).toEqual([{ kind: "menu", label: "Menu", url: "https://www.toasttab.com/bagel-depot" }]);
    expect(linksFrom({ menu: "https://169.254.169.254/latest/meta-data/" })).toEqual([]);
    expect(linksFrom({ menu: "https://192.168.1.1/menu", facebook: "https://router.local/x" })).toEqual([]);
    expect(linksFrom({ menu: "https://router.lan/menu", instagram: "https://router.home/x", facebook: "https://nas.corp/x" })).toEqual([]);
  });
});

