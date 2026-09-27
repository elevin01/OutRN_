import { describe, expect, it } from "vitest";
import { categoryFromTags, hoursConfidence, normalizeOsm } from "./osm-normalize.js";

const NOW = new Date("2026-09-26T12:00:00Z");
const rec = (tags: Record<string, string>, updated: string | null = "2026-08-01T00:00:00Z") => normalizeOsm({ externalId: "node/1", point: { lat: 40.7185, lon: -73.988 }, tags, sourceUpdatedAt: updated ? new Date(updated) : null }, NOW);
const fact = (n: ReturnType<typeof normalizeOsm>, attribute: string) => n.facts.find((f) => f.attribute === attribute);

describe("OSM normalization", () => {
  it("maps tags into the controlled vocabulary", () => {
    expect(categoryFromTags({ amenity: "pub" })).toBe("bar");
    expect(categoryFromTags({ amenity: "ice_cream" })).toBe("dessert");
    expect(categoryFromTags({ leisure: "nature_reserve" })).toBe("park");
    expect(categoryFromTags({ shop: "books" })).toBe("bookshop");
    expect(categoryFromTags({ shop: "shoes" })).toBeNull();
  });

  it("rejects unnamed or unmapped records without throwing", () => {
    expect(rec({ amenity: "cafe" }).rejects).toContain("no name");
    expect(rec({ name: "X", shop: "shoes" }).rejects).toContain("no mapped category");
  });

  it("published facts carry evidence; inferred ones are estimates", () => {
    const n = rec({ name: "Essex Coffee", amenity: "cafe", opening_hours: "Mo-Su 07:00-18:00", website: "https://essex.example" });
    expect(fact(n, "opening_hours")).toMatchObject({ evidenceClass: "published", evidence: "opening_hours=Mo-Su 07:00-18:00" });
    expect(fact(n, "admission")).toMatchObject({ evidenceClass: "estimate", value: { requirement: "walk_in" } });
    expect(fact(n, "indoor_outdoor")).toMatchObject({ evidenceClass: "estimate" });
  });

  it("hours confidence decays with the age of the OSM edit and never reaches a 'verified' level", () => {
    expect(hoursConfidence(new Date("2026-09-20T00:00:00Z"), NOW)).toBeCloseTo(0.62, 2);
    expect(hoursConfidence(new Date("2020-09-20T00:00:00Z"), NOW)).toBeCloseTo(0.3, 1);
    expect(hoursConfidence(null, NOW)).toBe(0.45);
  });

  it("unparseable hours are omitted and reported, never stored as hours", () => {
    const n = rec({ name: "Weird", amenity: "bar", opening_hours: "when the owner wakes up" });
    expect(fact(n, "opening_hours")).toBeUndefined();
    expect(n.rejects.some((r) => r.startsWith("unparseable opening_hours"))).toBe(true);
  });

  it("disused:* or opening_hours=off marks a permanent closure with evidence", () => {
    expect(fact(rec({ name: "Old Lounge", amenity: "bar", "disused:amenity": "bar" }), "business_status")).toMatchObject({ value: { status: "closed_permanently" }, evidence: "disused:amenity", evidenceClass: "published" });
    expect(fact(rec({ name: "Gone", amenity: "cafe", opening_hours: "off" }), "business_status")).toMatchObject({ value: { status: "closed_permanently" } });
    expect(fact(rec({ name: "Open", amenity: "cafe" }), "business_status")).toMatchObject({ value: { status: "operating" }, evidenceClass: "estimate" });
  });

  it("price only comes from tags: fee=no is free, fee=yes is paid-unknown, parks are estimated free", () => {
    expect(fact(rec({ name: "M", tourism: "museum", fee: "yes" }), "price")).toMatchObject({ evidenceClass: "published", value: { unknown: true, paid: true } });
    expect(fact(rec({ name: "G", leisure: "garden", fee: "no" }), "price")).toMatchObject({ evidenceClass: "published", value: { free: true } });
    expect(fact(rec({ name: "P", leisure: "park" }), "price")).toMatchObject({ evidenceClass: "estimate", value: { free: true } });
    expect(fact(rec({ name: "R", amenity: "restaurant" }), "price")).toBeUndefined();
  });

  it("admission: reservation=required is a published reservation requirement; museums with a fee are ticketed", () => {
    expect(fact(rec({ name: "R", amenity: "restaurant", reservation: "required" }), "admission")).toMatchObject({ evidenceClass: "published", value: { requirement: "reservation" } });
    expect(fact(rec({ name: "M", tourism: "museum", fee: "yes" }), "admission")).toMatchObject({ value: { requirement: "ticket" } });
  });

  it("activity venues map into the widened vocabulary (26 Sep: bowling alleys and nightclubs were invisible)", () => {
    expect(categoryFromTags({ leisure: "bowling_alley" })).toBe("bowling");
    expect(categoryFromTags({ leisure: "amusement_arcade" })).toBe("arcade");
    expect(categoryFromTags({ amenity: "nightclub" })).toBe("nightclub");
    expect(categoryFromTags({ amenity: "music_venue" })).toBe("live_music");
    for (const tags of [{ leisure: "escape_game" }, { leisure: "miniature_golf" }, { leisure: "ice_rink" }, { amenity: "karaoke_box" }, { amenity: "casino" }]) expect(categoryFromTags(tags)).toBe("activity");
    expect(categoryFromTags({ leisure: "sports_centre", sport: "climbing" })).toBe("activity");
    expect(categoryFromTags({ leisure: "sports_centre", sport: "soccer" })).toBeNull();
    expect(categoryFromTags({ tourism: "zoo" })).toBe("attraction");
    expect(categoryFromTags({ tourism: "aquarium" })).toBe("attraction");
    expect(categoryFromTags({ natural: "beach" })).toBe("waterfront");
    expect(categoryFromTags({ amenity: "events_venue" })).toBeNull(); // banquet halls: deliberately out
  });

  it("activity venues get admission estimates by kind; beaches are not assumed free", () => {
    expect(fact(rec({ name: "Homefield Bowl", leisure: "bowling_alley" }), "admission")).toMatchObject({ evidenceClass: "estimate", value: { requirement: "walk_in" } });
    expect(fact(rec({ name: "Room 13", leisure: "escape_game" }), "admission")).toMatchObject({ evidenceClass: "estimate", value: { requirement: "reservation" } });
    expect(fact(rec({ name: "Wall", leisure: "sports_centre", sport: "climbing" }), "category")).toMatchObject({ value: { value: "activity" }, evidence: "leisure=sports_centre + sport=climbing" });
    expect(fact(rec({ name: "Beach", natural: "beach" }), "price")).toBeUndefined();
    expect(fact(rec({ name: "Beach", natural: "beach" }), "indoor_outdoor")).toMatchObject({ value: { value: "outdoor" } });
  });
});
