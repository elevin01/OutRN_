import { describe, expect, it } from "vitest";
import { categoryFromTags, hoursConfidence, kidFacilitiesOf, normalizeOsm, osmDate, parkingKind, parseCharge, restroomOf, surveyedHoursConfidence, venueLinks } from "./osm-normalize.js";

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
      for (const bad of ["~1990", "before 2010", "2026-13", "2026-02-29", "2026-1-5", "", undefined, "9999-12-31", "9999", "0050", "0000-00-00", "+10000"]) expect(osmDate(bad)).toBeNull();
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

  it("happy_hours and outdoor_seating become facts where food or drink is served; unparseable or unknown values are dropped", () => {
    expect(fact(rec({ name: "Ten Bells", amenity: "bar", happy_hours: "Mo-Fr 17:00-19:00" }), "happy_hours")).toMatchObject({ evidenceClass: "published", value: { osm: "Mo-Fr 17:00-19:00" }, evidence: "happy_hours=Mo-Fr 17:00-19:00" });
    expect(fact(rec({ name: "Ten Bells", amenity: "bar", happy_hours: "when the owner feels like it" }), "happy_hours")).toBeUndefined();
    expect(fact(rec({ name: "Seward Park", leisure: "park", happy_hours: "Mo-Fr 17:00-19:00" }), "happy_hours")).toBeUndefined();
    // Any kind of table outside is a yes; "no" is a no; anything else says nothing.
    for (const v of ["yes", "sidewalk", "garden;street", "Roof", "only", "beach", "separate"]) expect(fact(rec({ name: "R", amenity: "restaurant", outdoor_seating: v }), "outdoor_seating"), v).toMatchObject({ evidenceClass: "published", value: { value: "yes" } });
    expect(fact(rec({ name: "R", amenity: "restaurant", outdoor_seating: "no" }), "outdoor_seating")).toMatchObject({ value: { value: "no" } });
    for (const v of ["maybe", "sidewalk;maybe", "", "constructor"]) expect(fact(rec({ name: "R", amenity: "restaurant", outdoor_seating: v }), "outdoor_seating"), v).toBeUndefined();
    expect(fact(rec({ name: "Books", shop: "books", outdoor_seating: "yes" }), "outdoor_seating")).toBeUndefined();
  });

  it("diets come from diet:* tags where food is served, else from the name as an estimate; wifi from internet_access anywhere", () => {
    expect(fact(rec({ name: "Jisu Vegetarian", amenity: "restaurant", "diet:vegan": "yes", "diet:vegetarian": "yes" }), "diets")).toMatchObject({ evidenceClass: "published", value: { vegetarian: "yes", vegan: "yes" }, evidence: "diet:vegetarian=yes; diet:vegan=yes" });
    // No tags: the name, as an estimate. With tags, the name adds nothing (the mapper said what they know).
    expect(fact(rec({ name: "East Side Glatt", amenity: "restaurant" }), "diets")).toMatchObject({ evidenceClass: "estimate", value: { kosher: "only" }, evidence: "name=East Side Glatt", confidence: 0.5 });
    expect(fact(rec({ name: "Madina Halal Deli", amenity: "restaurant", "diet:vegan": "no" }), "diets")).toMatchObject({ evidenceClass: "published", value: { vegan: "no" } });
    expect(fact(rec({ name: "Kosher Books", shop: "books", "diet:kosher": "only" }), "diets")).toBeUndefined();
    expect(fact(rec({ name: "Plain", amenity: "restaurant" }), "diets")).toBeUndefined();
    // Diet tags the mapper gave but we can't read say nothing, and the name doesn't overrule them.
    for (const tags of [{ "diet:vegan": "unknown" }, { "diet:vegan": "sometimes" }, { "diet:paleo": "yes" }]) expect(fact(rec({ name: "Vegan Cafe", amenity: "cafe", ...tags }), "diets"), JSON.stringify(tags)).toBeUndefined();
    expect(fact(rec({ name: "Vegan Cafe", amenity: "cafe" }), "diets")).toMatchObject({ evidenceClass: "estimate", value: { vegan: "only" } });
    // Wifi is wlan, whatever it's called; a list with wlan is wlan; anything unknown says nothing.
    const net = (v: string, tags: Record<string, string> = { amenity: "cafe" }) => (fact(rec({ name: "N", ...tags, internet_access: v }), "internet_access")?.value as { value?: string } | undefined)?.value ?? null;
    expect([net("wlan"), net("wifi"), net("yes, wifi"), net("yes"), net("no"), net("terminal")]).toEqual(["wlan", "wlan", "wlan", "yes", "no", "terminal"]);
    expect([net("maybe"), net("no;yes"), net(""), net("constructor")]).toEqual([null, null, null, null]);
    // A list that says no and something else contradicts itself, whichever comes first.
    expect([net("no;wlan"), net("wlan;no"), net("wifi, no")]).toEqual([null, null, null]);
    expect(net("wlan", { amenity: "library" })).toBe("wlan");
  });

  it("the seats are read once: the outdoor_seating fact and the setting always agree", () => {
    const both = (tags: Record<string, string>) => {
      const n = rec({ name: "R", amenity: "restaurant", ...tags });
      return [(fact(n, "outdoor_seating")?.value as { value?: string } | undefined)?.value ?? null, (fact(n, "indoor_outdoor")?.value as { value: string }).value];
    };
    // OSM's documented specific values count as tables outside.
    expect(both({ outdoor_seating: "beach" })).toEqual(["yes", "mixed"]);
    expect(both({ outdoor_seating: "separate" })).toEqual(["yes", "mixed"]);
    expect(both({ outdoor_seating: "sidewalk" })).toEqual(["yes", "mixed"]);
    // Seats only outside: the place is outdoors, so rain and cold count against it.
    expect(both({ outdoor_seating: "only" })).toEqual(["yes", "outdoor"]);
    expect(both({ outdoor_seating: "garden", indoor_seating: "no" })).toEqual(["yes", "outdoor"]);
    expect(fact(rec({ name: "R", amenity: "restaurant", outdoor_seating: "garden", indoor_seating: "no" }), "outdoor_seating")?.evidence).toBe("outdoor_seating=garden; indoor_seating=no");
    // No tables outside, or nothing we can read: indoors, as before.
    expect(both({ outdoor_seating: "no" })).toEqual(["no", "indoor"]);
    expect(both({ outdoor_seating: "maybe" })).toEqual([null, "indoor"]);
    expect(both({ indoor_seating: "no" })).toEqual([null, "indoor"]);
    expect(both({})).toEqual([null, "indoor"]);
  });

  it("opening_hours:kitchen becomes kitchen hours; an unparseable rule is dropped", () => {
    expect(fact(rec({ name: "R", amenity: "restaurant", opening_hours: "Mo-Su 12:00-23:00", "opening_hours:kitchen": "Mo-Su 12:00-22:00" }), "kitchen_hours")).toMatchObject({ evidenceClass: "published", value: { osm: "Mo-Su 12:00-22:00" }, evidence: "opening_hours:kitchen=Mo-Su 12:00-22:00" });
    expect(fact(rec({ name: "R", amenity: "restaurant", "opening_hours:kitchen": "until the chef leaves" }), "kitchen_hours")).toBeUndefined();
  });

  describe("restrooms and what a place has for children", () => {
    const rest = (tags: Record<string, string>) => restroomOf(tags);
    it("a restroom visitors may use, and its step-free access, as tagged", () => {
      expect(rest({ toilets: "yes" })).toEqual({ value: { available: "yes" }, evidence: "toilets=yes" });
      expect(rest({ toilets: "customers" })).toEqual({ value: { available: "yes" }, evidence: "toilets=customers" });
      expect(rest({ toilets: "no" })).toEqual({ value: { available: "no" }, evidence: "toilets=no" });
      expect(rest({ toilets: "yes", "toilets:wheelchair": "no" })).toEqual({ value: { available: "yes", wheelchair: "no" }, evidence: "toilets=yes; toilets:wheelchair=no" });
      // An accessible restroom is a restroom; an inaccessible one says nothing about whether there is another.
      expect(rest({ "toilets:wheelchair": "yes" })?.value).toEqual({ available: "yes", wheelchair: "yes" });
      expect(rest({ "toilets:wheelchair": "limited" })?.value).toEqual({ available: "yes", wheelchair: "limited" });
      expect(rest({ "toilets:wheelchair": "no" })?.value).toEqual({ wheelchair: "no" });
      // toilets:access decides who may use it: staff only is none for visitors.
      expect(rest({ toilets: "yes", "toilets:access": "private" })).toEqual({ value: { available: "no" }, evidence: "toilets=yes; toilets:access=private" });
      expect(rest({ "toilets:access": "customers" })?.value).toEqual({ available: "yes" });
      expect(rest({ toilets: "yes", "toilets:access": "customers" })?.evidence).toBe("toilets=yes");
      // None for visitors has no access to describe, whatever else is tagged.
      expect(rest({ toilets: "no", "toilets:wheelchair": "yes" })?.value).toEqual({ available: "no" });
      expect(rest({ toilets: "yes", "toilets:access": "no", "toilets:wheelchair": "yes" })?.value).toEqual({ available: "no" });
      // Built for wheelchair users is accessible.
      expect(rest({ toilets: "yes", "toilets:wheelchair": "designated" })).toEqual({ value: { available: "yes", wheelchair: "yes" }, evidence: "toilets=yes; toilets:wheelchair=designated" });
      // Values we don't know say nothing.
      expect(rest({ toilets: "maybe", "toilets:wheelchair": "maybe" })).toBeNull();
      expect(rest({ "toilets:wheelchair": "__proto__" })).toBeNull();
      expect(rest({ "toilets:unisex": "yes" })).toBeNull();
      expect(rest({})).toBeNull();
    });
    it("high chairs, a changing table, a kids' area: as OSM documents each", () => {
      expect(kidFacilitiesOf({ highchair: "yes", changing_table: "no" })).toEqual({ value: { highchair: "yes", changing_table: "no" }, evidence: "highchair=yes; changing_table=no" });
      expect(kidFacilitiesOf({ highchair: "4" })?.value).toEqual({ highchair: "yes" });
      expect(kidFacilitiesOf({ highchair: "0" })?.value).toEqual({ highchair: "no" });
      // Limited is partial, not absent: somewhere to change a diaper that isn't a table; a limited kids' area.
      expect(kidFacilitiesOf({ changing_table: "limited" })).toEqual({ value: { changing_table: "limited" }, evidence: "changing_table=limited" });
      expect(kidFacilitiesOf({ kids_area: "limited" })).toEqual({ value: { kids_area: "limited" }, evidence: "kids_area=limited" });
      // kids_area's documented forms: yes, designated, and where one is (kids_area:indoor / :outdoor).
      expect(kidFacilitiesOf({ kids_area: "designated" })).toEqual({ value: { kids_area: "yes" }, evidence: "kids_area=designated" });
      expect(kidFacilitiesOf({ "kids_area:indoor": "yes" })).toEqual({ value: { kids_area: "yes" }, evidence: "kids_area:indoor=yes" });
      expect(kidFacilitiesOf({ "kids_area:outdoor": "yes" })).toEqual({ value: { kids_area: "yes" }, evidence: "kids_area:outdoor=yes" });
      expect(kidFacilitiesOf({ kids_area: "yes", "kids_area:indoor": "yes" })?.value).toEqual({ kids_area: "yes" });
      // The documented tag says how much; the subtag only where.
      expect(kidFacilitiesOf({ kids_area: "limited", "kids_area:outdoor": "yes" })).toEqual({ value: { kids_area: "limited" }, evidence: "kids_area=limited; kids_area:outdoor=yes" });
      // kids_area=indoor|outdoor is a documented mistake for the subtags: it counts only when nothing documented says.
      expect(kidFacilitiesOf({ kids_area: "indoor" })).toEqual({ value: { kids_area: "yes" }, evidence: "kids_area=indoor" });
      expect(kidFacilitiesOf({ kids_area: "outdoor", "kids_area:indoor": "yes" })?.value).toEqual({ kids_area: "yes" });
      // Denied and present at once is a contradiction: it says nothing.
      expect(kidFacilitiesOf({ kids_area: "no", "kids_area:indoor": "yes" })).toBeNull();
      expect(kidFacilitiesOf({ kids_area: "no" })?.value).toEqual({ kids_area: "no" });
      expect(kidFacilitiesOf({ highchair: "some", changing_table: "room", "kids_area:indoor": "no" })).toBeNull();
      expect(kidFacilitiesOf({ "changing_table:location": "wheelchair_toilet" })).toBeNull();
    });
    it("become published facts where the place is one we list, and validate", () => {
      const n = rec({ name: "Pies", amenity: "cafe", toilets: "yes", "toilets:wheelchair": "no", highchair: "yes" });
      expect(fact(n, "restroom")).toMatchObject({ evidenceClass: "published", value: { available: "yes", wheelchair: "no" }, evidence: "toilets=yes; toilets:wheelchair=no", confidence: 0.7 });
      expect(fact(n, "kid_facilities")).toMatchObject({ evidenceClass: "published", value: { highchair: "yes" }, evidence: "highchair=yes" });
      expect(fact(rec({ name: "Pies", amenity: "cafe" }), "restroom")).toBeUndefined();
      expect(fact(rec({ name: "Shoes", shop: "shoes", toilets: "yes" }), "restroom")).toBeUndefined();
    });
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
    // A karaoke box is a bar with private rooms: the same estimate, food or not.
    for (const food of [{}, { cuisine: "korean" }]) expect(fact(rec({ name: "Sing", amenity: "karaoke_box", ...food }), "age_limit")).toMatchObject({ evidenceClass: "estimate", value: { minAge: 21 }, confidence: 0.5 });
    expect(fact(rec({ name: "Family karaoke", amenity: "karaoke_box", min_age: "0" }), "age_limit")).toMatchObject({ evidenceClass: "published", value: { minAge: 0 } });
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

  it("hostile dates never throw: one vandal edit must not abort an area's ingest", () => {
    const values = ["9999-12-31", "9999", "9999-12", "0000-00-00", "0050", "+10000", "2026-02-30", "NaN", "", ";", "1e9", "__proto__", "x".repeat(255)];
    for (const tag of ["end_date", "opening_date", "check_date", "survey:date", "check_date:opening_hours"]) {
      for (const v of values) expect(() => rec({ name: "X", amenity: "cafe", opening_hours: "24/7", [tag]: v }), `${tag}=${v}`).not.toThrow();
    }
    // "Never" is not a closing date.
    expect(fact(rec({ name: "X", amenity: "cafe", end_date: "9999-12-31" }), "scheduled_closure")).toBeUndefined();
  });

  it("an opening date more than a year ahead is not believed: anyone can edit OSM", () => {
    expect(fact(rec({ name: "S", amenity: "restaurant", opening_date: "2027-06-01" }), "business_status")).toMatchObject({ value: { status: "closed_temporarily" } });
    for (const far of ["2027-12-01", "9998-12-31"]) expect(fact(rec({ name: "S", amenity: "restaurant", opening_date: far }), "business_status"), far).toMatchObject({ value: { status: "operating" } });
  });

  it("cuisine becomes a published list of slugs where food is served; nowhere else", () => {
    expect(fact(rec({ name: "Lombardi's", amenity: "restaurant", cuisine: "Pizza; italian" }), "cuisine")).toMatchObject({ evidenceClass: "published", value: { values: ["pizza", "italian"] }, evidence: "cuisine=Pizza; italian", confidence: 0.8 });
    expect(fact(rec({ name: "Gastropub", amenity: "pub", cuisine: "burger" }), "cuisine")).toMatchObject({ value: { values: ["burger"] } });
    expect(fact(rec({ name: "Rex", amenity: "cafe", cuisine: "coffee_shop;breakfast" }), "cuisine")).toMatchObject({ value: { values: ["coffee_shop", "breakfast"] } });
    // Not a place that serves food, or nothing that reads as a cuisine: no fact.
    expect(fact(rec({ name: "Seward Park", leisure: "park", cuisine: "picnic" }), "cuisine")).toBeUndefined();
    expect(fact(rec({ name: "Odd", amenity: "restaurant", cuisine: ";;<b>" }), "cuisine")).toBeUndefined();
    expect(fact(rec({ name: "Plain", amenity: "restaurant" }), "cuisine")).toBeUndefined();
  });

  it("without a cuisine tag, what a food place's name says it serves is an estimate; a tag always wins", () => {
    expect(fact(rec({ name: "Arturo's Coal Oven Pizza", amenity: "restaurant" }), "cuisine")).toMatchObject({ evidenceClass: "estimate", value: { values: ["pizza"] }, evidence: "name=Arturo's Coal Oven Pizza", confidence: 0.5 });
    expect(fact(rec({ name: "Bagel Depot", amenity: "cafe" }), "cuisine")).toMatchObject({ evidenceClass: "estimate", value: { values: ["bagel"] } });
    expect(fact(rec({ name: "Sake Bar Izakaya", amenity: "bar" }), "cuisine")).toMatchObject({ value: { values: ["japanese"] } });
    // The mapper's tag is the claim, even when the name says otherwise.
    expect(fact(rec({ name: "Joe's Pizza", amenity: "restaurant", cuisine: "italian" }), "cuisine")).toMatchObject({ evidenceClass: "published", value: { values: ["italian"] } });
    // Only where food is served: a park or a shop named for a dish is not a restaurant.
    expect(fact(rec({ name: "Pizza Park", leisure: "park" }), "cuisine")).toBeUndefined();
    expect(fact(rec({ name: "Thai Books", shop: "books" }), "cuisine")).toBeUndefined();
  });

  it("takeaway becomes a published takeout fact; other values are ignored", () => {
    expect(fact(rec({ name: "Slice", amenity: "restaurant", takeaway: "only" }), "takeout")).toMatchObject({ evidenceClass: "published", value: { value: "only" }, evidence: "takeaway=only" });
    expect(fact(rec({ name: "Bistro", amenity: "restaurant", takeaway: "no" }), "takeout")).toMatchObject({ value: { value: "no" } });
    expect(fact(rec({ name: "Diner", amenity: "restaurant", takeaway: "sometimes" }), "takeout")).toBeUndefined();
  });

  describe("the venue's own links", () => {
    it("rebuilds Instagram and Facebook links from the handle, on the official host", () => {
      expect(venueLinks({ "contact:instagram": "https://instagram.com/essexcoffee?igsh=abc" })?.links).toEqual({ instagram: "https://www.instagram.com/essexcoffee/" });
      expect(venueLinks({ "contact:instagram": "@essex.coffee" })?.links).toEqual({ instagram: "https://www.instagram.com/essex.coffee/" });
      expect(venueLinks({ "contact:facebook": "https://m.facebook.com/EssexCoffeeNYC/" })?.links).toEqual({ facebook: "https://www.facebook.com/EssexCoffeeNYC" });
      expect(venueLinks({ website: "https://essex.example/", "website:menu": "https://essex.example/menu.pdf" })?.links).toEqual({ menu: "https://essex.example/menu.pdf" });
    });

    it("keeps a menu only on the venue's own site or a menu platform: anyone can edit website:menu", () => {
      expect(venueLinks({ website: "https://www.essexcoffee.com", "website:menu": "https://order.essexcoffee.com/menu" })?.links.menu).toBe("https://order.essexcoffee.com/menu");
      expect(venueLinks({ "contact:website": "essexcoffee.com", "website:menu": "https://www.essexcoffee.com/menu" })?.links.menu).toBe("https://www.essexcoffee.com/menu");
      expect(venueLinks({ "website:menu": "https://www.toasttab.com/essex-coffee" })?.links.menu).toBe("https://www.toasttab.com/essex-coffee");
      for (const tags of [
        { website: "https://essexcoffee.com", "website:menu": "https://essexcoffee.com.evil.example/menu" }, // a lookalike
        { website: "https://essexcoffee.com", "website:menu": "https://evil.example/essexcoffee/menu" }, // another site
        { "website:menu": "https://essexcoffee.com/menu" }, // no website to compare
        { website: "not a site", "website:menu": "https://essexcoffee.com/menu" },
        { website: "https://essexcoffee.com", "website:menu": "https://essex-coffee-order.square.site/" }, // a free site builder anyone can sign up to
        { website: "https://www.facebook.com/essexcoffee", "website:menu": "https://www.facebook.com/SomeoneElsesPage" }, // another tenant of a shared host
      ]) expect(venueLinks(tags), JSON.stringify(tags)).toBeNull();
      expect(venueLinks({ website: "https://www.facebook.com/essexcoffee", "website:menu": "https://www.facebook.com/essexcoffee/menu" })?.links.menu).toBe("https://www.facebook.com/essexcoffee/menu");
    });

    it("drops anything it cannot vouch for", () => {
      for (const tags of [
        { "contact:instagram": "https://instagram.com/p/Cx12ab" }, // a post, not an account
        { "contact:instagram": "https://evil.example/instagram.com/x" },
        { "contact:instagram": "javascript:alert(1)" },
        { "contact:facebook": "https://facebook.com/profile.php?id=123" },
        { "contact:facebook": "https://facebook.com.evil.example/page" },
        { "website:menu": "http://essex.example/menu" }, // not https
        { "website:menu": "https://user:pw@essex.example/menu" },
        { "website:menu": "javascript:alert(1)" },
        { "website:menu": "menu on the wall" },
      ]) expect(venueLinks(tags), JSON.stringify(tags)).toBeNull();
    });

    it("becomes one published links fact with its tags as evidence", () => {
      expect(fact(rec({ name: "Essex Coffee", amenity: "cafe", website: "https://essex.example/", "contact:instagram": "essexcoffee", "website:menu": "https://essex.example/menu" }), "links")).toMatchObject({
        evidenceClass: "published",
        value: { instagram: "https://www.instagram.com/essexcoffee/", menu: "https://essex.example/menu" },
        evidence: "contact:instagram=essexcoffee; website:menu=https://essex.example/menu",
      });
    });
  });

  describe("menu links from OSM point at public hosts only", () => {
    it("drops a website:menu on an IP literal or a network-local name", () => {
      for (const menu of ["https://169.254.169.254/latest/meta-data/", "https://192.168.1.1/menu", "https://[::1]/", "https://0x7f.1/", "https://router.local/menu", "https://intranet/menu", "https://router.lan/menu", "https://router.home/menu", "https://nas.corp/menu"]) {
        expect(venueLinks({ website: menu, "website:menu": menu }), menu).toBeNull();
      }
      expect(venueLinks({ website: "https://bageldepot.example", "website:menu": "https://bageldepot.example/menu.pdf" })?.links.menu).toBe("https://bageldepot.example/menu.pdf");
    });

    it("drops handles that are not accounts: a redirect path, or no letters at all", () => {
      for (const tags of [{ "contact:facebook": "https://facebook.com/l.php?u=https://evil.example" }, { "contact:facebook": ".." }, { "contact:instagram": ".." }, { "contact:instagram": "__" }]) {
        expect(venueLinks(tags), JSON.stringify(tags)).toBeNull();
      }
    });
  });
});

describe("who can go, and what it costs, when the tags don't say", () => {
  it("access=private or members-only: not open to the public", () => {
    for (const access of ["private", "no", "members", "permit"]) {
      const a = fact(rec({ name: "Club", amenity: "bar", access }), "admission");
      expect(a, access).toMatchObject({ value: { requirement: "members_only" }, evidenceClass: "published", evidence: `access=${access}` });
    }
    // Customers only is how every café works; permissive is open.
    for (const access of ["customers", "permissive", "yes"]) expect(fact(rec({ name: "Cafe", amenity: "cafe", access }), "admission")?.value, access).toEqual({ requirement: "walk_in" });
  });

  it("a university or school's own library is members only; a public library is free to walk into", () => {
    // Elmer Holmes Bobst Library, as mapped.
    const nyu = rec({ name: "Elmer Holmes Bobst Library", amenity: "library", building: "university", operator: "New York University" });
    expect(fact(nyu, "admission")).toMatchObject({ value: { requirement: "members_only" }, evidenceClass: "estimate" });
    expect(fact(nyu, "price")).toBeUndefined();
    for (const tags of [{ library: "academic" }, { operator: "Sarah Lawrence College" }, { operator: "Bronx High School of Science" }]) {
      expect(fact(rec({ name: "L", amenity: "library", ...tags }), "admission")?.value, JSON.stringify(tags)).toEqual({ requirement: "members_only" });
    }
    // The record's own access tag outweighs the guess: open to the public, or explicitly restricted.
    for (const access of ["yes", "permissive", "public"]) {
      const open = rec({ ...{ name: "Bobst", amenity: "library", building: "university", operator: "New York University" }, access });
      expect(fact(open, "admission")?.value, access).toEqual({ requirement: "walk_in" });
      expect(fact(open, "price")?.value, access).toMatchObject({ free: true });
    }
    for (const access of ["private", "no", "members", "permit"]) {
      expect(fact(rec({ name: "Bobst", amenity: "library", operator: "New York University", access }), "admission"), access).toMatchObject({ value: { requirement: "members_only" }, evidenceClass: "published" });
    }
    const nypl = rec({ name: "Seward Park Library", amenity: "library", operator: "New York Public Library" });
    expect(fact(nypl, "admission")?.value).toEqual({ requirement: "walk_in" });
    expect(fact(nypl, "price")).toMatchObject({ value: { free: true }, evidenceClass: "estimate" });
    expect(fact(rec({ name: "Bronxville Public Library", amenity: "library", operator: "Village of Bronxville Public Library" }), "admission")?.value).toEqual({ requirement: "walk_in" });
  });

  it("a commercial art gallery is a free walk-in, unless its tags say there's a charge", () => {
    const g = rec({ name: "Gallery", tourism: "gallery" });
    expect(fact(g, "price")).toMatchObject({ value: { free: true }, evidenceClass: "estimate" });
    expect(fact(g, "admission")?.value).toEqual({ requirement: "walk_in" });
    const paid = rec({ name: "Gallery", tourism: "gallery", fee: "yes" });
    expect(fact(paid, "price")?.value).toMatchObject({ paid: true });
    expect(fact(paid, "admission")?.value).toEqual({ requirement: "ticket" });
  });
});

describe("tag values that name what every object inherits", () => {
  const INHERITED = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"];
  const rec = (tags: Record<string, string>) => ({ externalId: "node/1", point: { lat: 40.72, lon: -73.99 }, timezone: "America/New_York", tags, sourceUpdatedAt: null });

  it("are not categories: a museum stays a museum, and otherwise they count as unrecognized values", () => {
    for (const v of INHERITED) {
      // Overpass returns this element for tourism=museum; the other tag must not win.
      expect(categoryFromTags({ name: "X", amenity: v, tourism: "museum" }), v).toBe("museum");
      const n = normalizeOsm(rec({ name: "X", amenity: v, tourism: "museum" }), new Date("2026-09-28T12:00:00Z"));
      expect(n.category, v).toBe("museum");
      expect(n.facts.every((f) => typeof JSON.stringify(f.value) === "string" && !JSON.stringify(f.value).includes("{}")), v).toBe(true);
      // With nothing else to go on, it is an unrecognized value like any other.
      const bare = normalizeOsm(rec({ name: "X", amenity: v }), new Date("2026-09-28T12:00:00Z"));
      const unknown = normalizeOsm(rec({ name: "X", amenity: "not_a_known_value" }), new Date("2026-09-28T12:00:00Z"));
      expect(bare.category, v).toBe(unknown.category);
      expect(typeof bare.category === "string" || bare.category === null, v).toBe(true);
    }
  });

  it("are not parking kinds: they read as unknown, like any unmapped parking=* value", () => {
    for (const v of INHERITED) {
      expect(parkingKind(v), v).toBe("unknown");
      const n = normalizeOsm(rec({ name: "X", amenity: "cafe", parking: v }), new Date("2026-09-28T12:00:00Z"));
      expect(n.facts.find((f) => f.attribute === "parking")?.value, v).toEqual({ kind: "unknown", cost: "unknown" });
    }
  });
});

