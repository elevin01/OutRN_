import { describe, expect, it } from "vitest";
import { AUTO_MERGE_THRESHOLD, REVIEW_THRESHOLD, matchKey, scorePair, type IdentityRecord } from "./score.js";

const base: IdentityRecord = { name: "Orchard St. Coffee", category: "cafe", point: { lat: 40.7185, lon: -73.988 }, website: "https://orchardstcoffee.example", phone: null, housenumber: null, street: null, brand: null };
const near = (m: number) => ({ lat: 40.7185 + m / 111_320, lon: -73.988 });

describe("identity scoring", () => {
  it("normalizes abbreviations and punctuation into one match key", () => {
    expect(matchKey("Orchard St. Coffee")).toBe(matchKey("Orchard Street Coffee"));
    expect(matchKey("The Café Grumpy")).toBe("cafe grumpy");
    expect(matchKey("Tenement Museum")).not.toBe(matchKey("Tenement Museum Café"));
  });

  it("same café mapped as node and building way → auto merge", () => {
    const s = scorePair(base, { ...base, name: "Orchard Street Coffee", point: near(16) });
    expect(s.relation).toBe("same");
    expect(s.score).toBeGreaterThanOrEqual(AUTO_MERGE_THRESHOLD);
    expect(s.evidence["website"]).toBe("same");
  });

  it("two branches of a chain sharing a homepage and phone never merge", () => {
    const a: IdentityRecord = { name: "Bagel Depot", category: "cafe", point: near(0), website: "https://bageldepot.example", phone: "+1 212 555 0100", housenumber: "12", street: "Essex Street", brand: "Bagel Depot" };
    const b: IdentityRecord = { ...a, point: near(60), housenumber: "88", street: "Rivington Street" };
    const s = scorePair(a, b);
    expect(s.relation).toBe("different");
    expect(s.score).toBeLessThan(REVIEW_THRESHOLD);
    expect(s.evidence["address"]).toBe("different");
    expect(s.evidence["website"]).toBe("shared_chain_domain");
  });

  it("same chain branch, same address, mapped twice → merge despite the brand", () => {
    const a: IdentityRecord = { name: "Bagel Depot", category: "cafe", point: near(0), website: "https://bageldepot.example", phone: null, housenumber: "12", street: "Essex St", brand: "Bagel Depot" };
    const b: IdentityRecord = { ...a, point: near(10), street: "Essex Street" };
    expect(scorePair(a, b).relation).toBe("same");
  });

  it("a museum café next to the museum is a child, not a duplicate", () => {
    const museum: IdentityRecord = { name: "Tenement Story Museum", category: "museum", point: near(0), website: "https://tenementstory.example", phone: null, housenumber: null, street: null, brand: null };
    const cafe: IdentityRecord = { ...museum, name: "Tenement Story Museum Café", category: "cafe", point: near(7) };
    const s = scorePair(cafe, museum);
    expect(s.relation).toBe("child_of");
    expect(s.evidence["child_suffix"]).toBe("cafe");
  });

  it("an explicit shared identifier settles it regardless of everything else", () => {
    const a: IdentityRecord = { ...base, xids: { wikidata: "Q42" } };
    const b: IdentityRecord = { ...base, name: "Totally Different", category: "museum", point: near(200), website: null, xids: { wikidata: "Q42" } };
    expect(scorePair(a, b).score).toBe(1);
  });

  it("similar names far apart are different places", () => {
    const s = scorePair(base, { ...base, website: null, point: near(400) });
    expect(s.relation).toBe("different");
    expect(s.score).toBeLessThan(REVIEW_THRESHOLD);
  });

  it("same name, same category, 100 m apart, no contact details → review, not auto", () => {
    const s = scorePair({ ...base, website: null }, { ...base, website: null, point: near(100) });
    expect(s.score).toBeGreaterThanOrEqual(REVIEW_THRESHOLD);
    expect(s.score).toBeLessThan(AUTO_MERGE_THRESHOLD);
  });
});
