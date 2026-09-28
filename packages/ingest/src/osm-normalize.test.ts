import { describe, expect, it } from "vitest";
import { categoryFromTags, hoursConfidence, normalizeOsm, osmDate, parseCharge, surveyedHoursConfidence } from "./osm-normalize.js";

const NOW = new Date("2026-09-26T12:00:00Z");
const rec = (tags: Record<string, string>, updated: string | null = "2026-08-01T00:00:00Z", now = NOW) => normalizeOsm({ externalId: "node/1", point: { lat: 40.7185, lon: -73.988 }, timezone: "America/New_York", tags, sourceUpdatedAt: updated ? new Date(updated) : null }, now);
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

  it("OSM parking=* values map into the controlled parking kinds, never passed through raw", () => {
    expect(fact(rec({ name: "Lot", amenity: "cafe", parking: "multi-storey" }), "parking")).toMatchObject({ value: { kind: "garage" } });
    expect(fact(rec({ name: "Lot", amenity: "cafe", parking: "street_side", "parking:fee": "no" }), "parking")).toMatchObject({ value: { kind: "street", cost: "free" } });
    expect(fact(rec({ name: "Lot", amenity: "cafe", parking: "something_new" }), "parking")).toMatchObject({ value: { kind: "unknown" } });
  });

  it("activity venues carry their kind; age limits are one number, published from min_age or estimated by kind", () => {
    const casino = rec({ name: "Empire City", amenity: "casino" });
    expect(fact(casino, "subtype")).toMatchObject({ evidenceClass: "published", value: { value: "casino" } });
    expect(fact(casino, "age_limit")).toMatchObject({ evidenceClass: "estimate", value: { minAge: 21 } });
    expect(fact(rec({ name: "Club", amenity: "nightclub" }), "age_limit")).toMatchObject({ evidenceClass: "estimate", value: { minAge: 21 } });
    const golf = rec({ name: "Putt", leisure: "miniature_golf" });
    expect(fact(golf, "subtype")).toMatchObject({ value: { value: "miniature_golf" } });
    expect(fact(golf, "age_limit")).toBeUndefined(); // unknown, not "all ages"
    for (const [tag, minAge] of [["0", 0], ["16", 16], ["18", 18], ["21", 21]] as const) {
      expect(fact(rec({ name: "Arcade", leisure: "amusement_arcade", min_age: tag }), "age_limit")).toMatchObject({ evidenceClass: "published", value: { minAge }, evidence: `min_age=${tag}` });
    }
    // A published min_age beats the kind's default.
    expect(fact(rec({ name: "Kids casino night", amenity: "casino", min_age: "18" }), "age_limit")).toMatchObject({ evidenceClass: "published", value: { minAge: 18 } });
    expect(fact(rec({ name: "Wall", leisure: "sports_centre", sport: "climbing" }), "subtype")).toMatchObject({ value: { value: "climbing" } });
    expect(fact(rec({ name: "R", amenity: "restaurant" }), "subtype")).toBeUndefined();
  });

  describe("survey dates (check_date)", () => {
    it("check_date:opening_hours dates the hours by the mapper's survey, not by the last edit", () => {
      // Edited this month (a name fix), hours surveyed three years ago: the survey is what the hours rest on.
      const n = rec({ name: "Essex Coffee", amenity: "cafe", opening_hours: "Mo-Su 07:00-18:00", "check_date:opening_hours": "2026-03-10" }, "2026-09-20T00:00:00Z");
      const h = fact(n, "opening_hours")!;
      expect(h).toMatchObject({ evidenceClass: "published", evidence: "opening_hours=Mo-Su 07:00-18:00; check_date:opening_hours=2026-03-10" });
      expect(h.observedAt).toEqual(new Date("2026-03-10T12:00:00Z")); // the calendar day, as its midday
      expect(h.sourceUpdatedAt).toEqual(new Date("2026-09-20T00:00:00Z")); // the edit stays the edit
      expect(h.confidence).toBeCloseTo(surveyedHoursConfidence(new Date("2026-03-10T00:00:00Z"), NOW), 3);
      expect(h.confidence).toBeGreaterThan(hoursConfidence(new Date("2026-09-20T00:00:00Z"), NOW));
    });

    it("an old survey never lowers hours below what the edit date gives them", () => {
      const h = fact(rec({ name: "C", amenity: "cafe", opening_hours: "Mo-Su 07:00-18:00", "check_date:opening_hours": "2019-05-01" }, "2026-09-01T00:00:00Z"), "opening_hours")!;
      expect(h.confidence).toBeCloseTo(hoursConfidence(new Date("2026-09-01T00:00:00Z"), NOW), 3);
    });

    it("survey confidence stays below a venue's own site and decays with age", () => {
      expect(surveyedHoursConfidence(new Date("2026-09-20T00:00:00Z"), NOW)).toBeCloseTo(0.72, 2);
      expect(surveyedHoursConfidence(new Date("2016-01-01T00:00:00Z"), NOW)).toBe(0.3);
    });

    it("ignores survey dates in the future, after their own edit, or that do not parse", () => {
      for (const d of ["2027-01-01", "2026-09-25", "last spring", "2026-02-30"]) {
        const h = fact(rec({ name: "C", amenity: "cafe", opening_hours: "Mo-Su 07:00-18:00", "check_date:opening_hours": d }), "opening_hours")!;
        expect(h.observedAt).toBeUndefined();
        expect(h.evidence).toBe("opening_hours=Mo-Su 07:00-18:00");
      }
    });

    it("a recent check_date or survey:date publishes the place as operating; an old one does not", () => {
      const s = fact(rec({ name: "Open", amenity: "cafe", check_date: "2025-11-02" }), "business_status")!;
      expect(s).toMatchObject({ evidenceClass: "published", value: { status: "operating" }, evidence: "check_date=2025-11-02" });
      expect(s.observedAt).toEqual(new Date("2025-11-02T12:00:00Z"));
      // It counts for three years from the survey, then lapses; ingest re-normalizes the record then.
      expect(s.validUntil).toEqual(new Date("2028-11-02T12:00:00Z"));
      expect(rec({ name: "Open", amenity: "cafe", check_date: "2025-11-02" }).changesAt).toEqual(new Date("2028-11-02T12:00:00Z"));
      expect(s.confidence).toBeGreaterThan(0.5); // above presence alone (a 0.5 estimate)
      expect(fact(rec({ name: "Open", amenity: "cafe", "survey:date": "2026-01" }), "business_status")).toMatchObject({ evidenceClass: "published", evidence: "survey:date=2026-01" });
      // Surveying the hours means someone saw it open: the latest survey of any kind counts.
      expect(fact(rec({ name: "Open", amenity: "cafe", check_date: "2024-01-01", "check_date:opening_hours": "2026-05-01", opening_hours: "Mo-Su 08:00-17:00" }), "business_status")).toMatchObject({ evidence: "check_date:opening_hours=2026-05-01" });
      expect(fact(rec({ name: "Old", amenity: "cafe", check_date: "2021-06-01" }), "business_status")).toMatchObject({ evidenceClass: "estimate" });
    });

    it("a survey is never a closure override: disused tags still close the place", () => {
      expect(fact(rec({ name: "Gone", "disused:amenity": "cafe", amenity: "cafe", check_date: "2026-05-01" }), "business_status")).toMatchObject({ value: { status: "closed_permanently" } });
    });
  });

  describe("lifecycle dates", () => {
    it("parses only real OSM dates, as the period they name", () => {
      expect(osmDate("2026-03-10")).toEqual({ start: new Date("2026-03-10T00:00:00Z"), end: new Date("2026-03-10T23:59:59.999Z") });
      expect(osmDate("2026-02")!.end).toEqual(new Date("2026-02-28T23:59:59.999Z"));
      expect(osmDate("2025")!.start).toEqual(new Date("2025-01-01T00:00:00Z"));
      for (const bad of ["~1990", "before 2010", "2026-13", "2026-02-29", "2026-1-5", "", undefined]) expect(osmDate(bad)).toBeNull();
    });

    it("end_date in the past closes the place permanently", () => {
      expect(fact(rec({ name: "Ended", amenity: "restaurant", end_date: "2025-12-31" }), "business_status")).toMatchObject({ evidenceClass: "published", value: { status: "closed_permanently" }, evidence: "end_date=2025-12-31", confidence: 0.75 });
      // This year, not over yet: likely gone, still at a confidence that excludes.
      expect(fact(rec({ name: "Ending", amenity: "restaurant", end_date: "2026" }), "business_status")).toMatchObject({ value: { status: "closed_permanently" }, confidence: 0.6 });
      // A closing date still ahead: operating until then, and the record is due for another look that day.
      const later = rec({ name: "Later", amenity: "restaurant", end_date: "2027-06-01" });
      expect(fact(later, "business_status")).toMatchObject({ value: { status: "operating" }, validUntil: new Date("2027-06-01T04:00:00Z") });
      expect(later.changesAt).toEqual(new Date("2027-06-01T04:00:00Z"));
      expect(fact(later, "scheduled_closure")).toMatchObject({ evidenceClass: "published", value: { at: "2027-06-01T04:00:00.000Z" }, evidence: "end_date=2027-06-01" });
      expect(fact(rec({ name: "Plain", amenity: "restaurant" }), "scheduled_closure")).toBeUndefined();
      expect(rec({ name: "Plain", amenity: "restaurant" }).changesAt).toBeNull();
    });

    it("opening_date in the future is closed until that day, then lapses", () => {
      const s = fact(rec({ name: "Soon", amenity: "restaurant", opening_date: "2026-10-15" }), "business_status")!;
      expect(s).toMatchObject({ evidenceClass: "published", value: { status: "closed_temporarily" }, evidence: "opening_date=2026-10-15" });
      expect(s.validUntil).toEqual(new Date("2026-10-15T04:00:00Z")); // midnight in New York (EDT), the day it opens
      expect(fact(rec({ name: "Opened", amenity: "restaurant", opening_date: "2026-01-15" }), "business_status")).toMatchObject({ value: { status: "operating" } });
    });
  });

  it("opening_hours:kitchen becomes kitchen hours; an unparseable rule is dropped", () => {
    expect(fact(rec({ name: "R", amenity: "restaurant", opening_hours: "Mo-Su 12:00-23:00", "opening_hours:kitchen": "Mo-Su 12:00-22:00" }), "kitchen_hours")).toMatchObject({ evidenceClass: "published", value: { osm: "Mo-Su 12:00-22:00" }, evidence: "opening_hours:kitchen=Mo-Su 12:00-22:00" });
    expect(fact(rec({ name: "R", amenity: "restaurant", "opening_hours:kitchen": "until the chef leaves" }), "kitchen_hours")).toBeUndefined();
  });

  describe("charge", () => {
    it("parses dollar amounts, ranges and several prices", () => {
      expect(parseCharge("12 USD")).toEqual({ min: 12, max: 12, basis: "per_person" });
      expect(parseCharge("USD 12")).toEqual({ min: 12, max: 12, basis: "per_person" });
      expect(parseCharge("$12.50")).toEqual({ min: 12.5, max: 12.5, basis: "per_person" });
      expect(parseCharge("10-15 USD")).toEqual({ min: 10, max: 15, basis: "per_person" });
      expect(parseCharge("$10 – $15")).toEqual({ min: 10, max: 15, basis: "per_person" });
      expect(parseCharge("25 USD/person")).toEqual({ min: 25, max: 25, basis: "per_person" });
      expect(parseCharge("20 USD; 10 USD")).toEqual({ min: 10, max: 20, basis: "per_person" });
      expect(parseCharge("60 USD/group")).toEqual({ min: 60, max: 60, basis: "per_group" });
    });

    it("refuses what is not a dollar price per visit", () => {
      for (const bad of ["5 USD/hour", "20 USD/day", "10 USD/vehicle", "12 EUR", "12", "free", "adult 20 USD", "20 USD; ask", ""]) expect(parseCharge(bad)).toBeNull();
    });

    it("becomes a published price and, for museums, a ticket; fee=no still wins", () => {
      const m = rec({ name: "M", tourism: "museum", fee: "yes", charge: "25 USD" });
      expect(fact(m, "price")).toMatchObject({ evidenceClass: "published", value: { paid: true, min: 25, max: 25, currency: "USD", basis: "per_person" }, evidence: "charge=25 USD" });
      expect(fact(rec({ name: "M", tourism: "museum", charge: "25 USD" }), "admission")).toMatchObject({ value: { requirement: "ticket" }, evidence: "charge=25 USD" });
      expect(fact(rec({ name: "G", leisure: "garden", charge: "0 USD" }), "price")).toMatchObject({ value: { free: true } });
      expect(fact(rec({ name: "G", leisure: "garden", fee: "no", charge: "5 USD" }), "price")).toMatchObject({ value: { free: true }, evidence: "fee=no" });
      // A charge that is not a visit price leaves fee=yes as paid, amount unknown.
      expect(fact(rec({ name: "Z", tourism: "museum", fee: "yes", charge: "5 USD/hour" }), "price")).toMatchObject({ value: { unknown: true, paid: true } });
    });
  });

  it("bars without a food signal are estimated 21+; food, a cuisine or kitchen hours leave age unknown", () => {
    expect(fact(rec({ name: "Nightcap", amenity: "bar" }), "age_limit")).toMatchObject({ evidenceClass: "estimate", value: { minAge: 21 }, confidence: 0.5 });
    expect(fact(rec({ name: "Pub", amenity: "pub", food: "no" }), "age_limit")).toMatchObject({ value: { minAge: 21 } });
    for (const food of [{ food: "yes" }, { cuisine: "burger" }, { "opening_hours:kitchen": "Mo-Su 12:00-22:00" }]) expect(fact(rec({ name: "Gastropub", amenity: "pub", ...food }), "age_limit")).toBeUndefined();
    // A published limit always wins.
    expect(fact(rec({ name: "All ages", amenity: "bar", min_age: "0" }), "age_limit")).toMatchObject({ evidenceClass: "published", value: { minAge: 0 } });
  });

  it("lifecycle dates take effect at local midnight in the place's timezone, DST days included", () => {
    const closure = (end: string) => (fact(rec({ name: "R", amenity: "restaurant", end_date: end }), "scheduled_closure")!.value as { at: string }).at;
    expect(closure("2026-11-10")).toBe("2026-11-10T05:00:00.000Z"); // EST
    expect(closure("2026-11-01")).toBe("2026-11-01T04:00:00.000Z"); // fall-back day: midnight is still EDT
    expect(closure("2027-03-14")).toBe("2027-03-14T05:00:00.000Z"); // spring-forward day: midnight is still EST
    // Early on the closing day it is already closed; late the evening before it is not.
    const tags = { name: "R", amenity: "restaurant", end_date: "2026-11-10" };
    expect(fact(rec(tags, null, new Date("2026-11-10T05:01:00Z")), "business_status")).toMatchObject({ value: { status: "closed_permanently" } });
    expect(fact(rec(tags, null, new Date("2026-11-10T04:59:00Z")), "business_status")).toMatchObject({ value: { status: "operating" } });
    // An opening day: temporarily closed until its midnight, then not.
    const opening = { name: "S", amenity: "restaurant", opening_date: "2027-03-14" };
    expect(fact(rec(opening, null, new Date("2027-03-14T04:59:00Z")), "business_status")).toMatchObject({ value: { status: "closed_temporarily" }, validUntil: new Date("2027-03-14T05:00:00Z") });
    expect(fact(rec(opening, null, new Date("2027-03-14T05:01:00Z")), "business_status")).toMatchObject({ value: { status: "operating" } });
  });
});

