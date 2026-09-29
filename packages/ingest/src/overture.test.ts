import { describe, expect, it } from "vitest";
import { matchKey } from "@outrn/core";
import type { OverturePlace } from "@outrn/sources";
import { bboxAround, claimsFor, domainNamesVenue, genericName, matchVenue, PlaceIndex, venuePhone, venueWebsite, type MatchVenue, type OvertureMatch } from "./overture.js";

const AT = { lat: 40.7205, lon: -73.9881 };
/** A point `m` metres north of AT. */
const north = (m: number) => ({ lat: AT.lat + m / 111_320, lon: AT.lon });

const place = (over: Partial<OverturePlace> = {}): OverturePlace => ({
  id: "p",
  name: "Grand Kitchen",
  ...AT,
  category: "restaurant",
  status: "open",
  statusSignal: null,
  statusUpdatedAt: null,
  confidence: 0.9,
  websites: [],
  phones: [],
  updatedAt: "2026-09-01T00:00:00.000Z",
  datasets: ["meta"],
  licenses: ["CDLA-Permissive-2.0"],
  ...over,
});
const venue = (name: string, category: MatchVenue["category"] = "restaurant", at = AT): MatchVenue => ({ id: "v", nameKey: matchKey(name), category, ...at });
const match = (v: MatchVenue, ...places: OverturePlace[]) => matchVenue(v, new PlaceIndex(places));
const m = (over: Partial<OverturePlace>, name: OvertureMatch["name"] = "same", metres = 5): OvertureMatch => ({ place: place(over), metres, name });

describe("matching venues to Overture places", () => {
  it("the same name within 120 m, whatever kind each source calls it", () => {
    expect(match(venue("Grand Kitchen"), place({ ...north(110) }))).toHaveLength(1);
    expect(match(venue("Grand Kitchen"), place({ ...north(130) }))).toHaveLength(0);
    // Spacing and punctuation aside; Overture files community gardens under arts and entertainment.
    expect(match(venue("SLEEPCENTER", "gallery"), place({ name: "Sleep Center", category: "art_gallery" }))[0]?.name).toBe("same");
    expect(match(venue("Parque de Tranquilidad", "garden"), place({ name: "Parque de Tranquilidad", category: "arts_and_entertainment" }))).toHaveLength(1);
  });

  it("a name that starts with or contains the other's: within 40 m, whole words, and a kind that fits", () => {
    expect(match(venue("Rong Hang"), place({ name: "Rong Hang Restaurant" }))[0]?.name).toBe("prefix");
    expect(match(venue("Ballato"), place({ name: "Emilio's Ballato" }))[0]?.name).toBe("within");
    // A street name alone matches every "Delancey …" on the block: not 50 m away.
    expect(match(venue("The Delancey", "bar"), place({ name: "Delancey Grill", category: "casual_eatery", ...north(53) }))).toHaveLength(0);
    // A garden is no restaurant, however alike the names.
    expect(match(venue("Seward Park", "park"), place({ name: "Seward Park Diner", category: "restaurant" }))).toHaveLength(0);
    // Whole words, and five characters at least.
    expect(match(venue("Rong"), place({ name: "Rong Hang" }))).toHaveLength(0);
    expect(match(venue("Hang Out"), place({ name: "Hangout Bar Hang Outs" }))).toHaveLength(0);
  });

  it("best first: the same name, then Overture's confidence, then the nearest", () => {
    const got = match(venue("Grand Kitchen"), place({ id: "prefix", name: "Grand Kitchen Bar", confidence: 0.99 }), place({ id: "far", ...north(50), confidence: 0.9 }), place({ id: "near", ...north(5), confidence: 0.9 }), place({ id: "sure", ...north(80), confidence: 0.95 }));
    expect(got.map((x) => x.place.id)).toEqual(["sure", "near", "far", "prefix"]);
  });
});

describe("what a venue's matches claim", () => {
  const none = { website: false, phone: false };
  const GK = { nameKey: "grand kitchen", category: "restaurant" } as const;
  it("open with Overture's status signal: operating at 0.75; with only a confident record: 0.6; otherwise nothing", () => {
    expect(claimsFor(GK, [m({ statusSignal: 1, statusUpdatedAt: "2026-06-26T16:25:14.000Z" })], none)).toEqual([
      expect.objectContaining({ attribute: "business_status", value: { status: "operating" }, confidence: 0.75, sourceUpdatedAt: new Date("2026-06-26T16:25:14Z") }),
    ]);
    expect(claimsFor(GK, [m({ confidence: 0.85 })], none)).toEqual([expect.objectContaining({ value: { status: "operating" }, confidence: 0.6 })]);
    expect(claimsFor(GK, [m({ confidence: 0.65 })], none)).toEqual([]);
  });

  it("closed only on Overture's signal, for the same name close by, and never while a duplicate is open", () => {
    const closed = { status: "permanently_closed", statusSignal: 1 } as const;
    expect(claimsFor(GK, [m(closed)], none)).toEqual([expect.objectContaining({ value: { status: "closed_permanently" }, confidence: 0.65 })]);
    // A company register's "closed" (no signal) is not a closed storefront.
    expect(claimsFor(GK, [m({ status: "permanently_closed" })], none)).toEqual([]);
    expect(claimsFor(GK, [m(closed, "prefix")], none)).toEqual([]);
    expect(claimsFor(GK, [m(closed, "same", 80)], none)).toEqual([]);
    expect(claimsFor(GK, [m(closed), m({ confidence: 0.95 })], none)).toEqual([expect.objectContaining({ value: { status: "operating" } })]);
    // Temporarily closed: no date to lapse on, so nothing.
    expect(claimsFor(GK, [m({ status: "temporarily_closed", statusSignal: 1 })], none)).toEqual([]);
  });

  describe("a permanent closure needs every condition", () => {
    const closed: Partial<OverturePlace> = { status: "permanently_closed", statusSignal: 1, confidence: 0.9, datasets: ["meta"] };
    const closes = (venue: { nameKey: string; category: MatchVenue["category"] }, ...matches: OvertureMatch[]) =>
      claimsFor(venue, matches, none).some((c) => (c.value as { status?: string }).status === "closed_permanently");

    it("the signal, the same name within 60 m, a kind the venue's could be, a confident record from more than a company register", () => {
      expect(closes(GK, m(closed))).toBe(true);
      expect(closes(GK, m({ ...closed, statusSignal: 0.85 }))).toBe(false);
      expect(closes(GK, m(closed, "same", 61))).toBe(false);
      expect(closes(GK, m(closed, "prefix"))).toBe(false);
      // The same name, filed as another kind: a closed "Grand Kitchen" furniture store says nothing about the restaurant.
      expect(closes(GK, m({ ...closed, category: "museum" }))).toBe(false);
      expect(closes({ nameKey: "grand kitchen", category: "museum" }, m(closed))).toBe(false);
      expect(closes({ nameKey: "grand kitchen", category: "bar" }, m({ ...closed, category: "bar" }))).toBe(true);
      // A company register's closure, even with the signal: a dissolved company is not a closed storefront.
      expect(closes(GK, m({ ...closed, datasets: ["BrightQuery"] }))).toBe(false);
      expect(closes(GK, m({ ...closed, datasets: [] }))).toBe(false);
      expect(closes(GK, m({ ...closed, datasets: ["BrightQuery", "meta"] }))).toBe(true);
      // Overture itself unsure the record describes a real place.
      expect(closes(GK, m({ ...closed, confidence: 0.26 }))).toBe(false);
      expect(closes(GK, m({ ...closed, confidence: null }))).toBe(false);
      expect(closes(GK, m({ ...closed, confidence: 0.5 }))).toBe(true);
    });

    it("never while any match is temporarily closed", () => {
      expect(closes(GK, m(closed), m({ status: "temporarily_closed", confidence: 0.3 }, "within", 30))).toBe(false);
    });

    it("never for a name of only generic words: another deli of that name is as likely", () => {
      expect(genericName(matchKey("Deli & Grocery"))).toBe(true);
      expect(genericName(matchKey("Pizza"))).toBe(true);
      expect(genericName(matchKey("Grand Kitchen"))).toBe(false);
      expect(closes({ nameKey: matchKey("Deli & Grocery"), category: "market" }, m({ ...closed, name: "Deli & Grocery", category: "food_and_beverage_store" }))).toBe(false);
      expect(closes({ nameKey: matchKey("Pizza"), category: "restaurant" }, m({ ...closed, name: "Pizza" }))).toBe(false);
      expect(closes({ nameKey: matchKey("Joe's Pizza"), category: "restaurant" }, m({ ...closed, name: "Joe's Pizza" }))).toBe(true);
    });
  });

  it("a website and phone only when no other source has one, from the venue itself, never a closed place", () => {
    const withContact = { websites: ["grandkitchen.com"], phones: ["212 555 0100"], confidence: 0.5 };
    expect(claimsFor(GK, [m(withContact)], none).map((c) => [c.attribute, c.value])).toEqual([
      ["website", { value: "https://grandkitchen.com/" }],
      ["phone", { value: "+1 212-555-0100" }],
    ]);
    expect(claimsFor(GK, [m(withContact)], { website: true, phone: true })).toEqual([]);
    // Something inside the venue ("Pickle Guys - Essex Market") is not the venue.
    expect(claimsFor(GK, [m(withContact, "within")], none)).toEqual([]);
    expect(claimsFor(GK, [m({ ...withContact, status: "permanently_closed" })], none)).toEqual([]);
    // A review in a magazine is not the venue's website; the next place's own site is.
    const review = m({ websites: ["http://nymag.com/listings/bar/grand-kitchen"], phones: [] });
    expect(claimsFor(GK, [review, m({ websites: ["https://www.grandkitchennyc.com/?utm_source=gmb&y_source=1_abc&page=2#top"] })], none).filter((c) => c.attribute === "website").map((c) => c.value)).toEqual([{ value: "https://www.grandkitchennyc.com/?page=2" }]);
  });
});

describe("contact details", () => {
  it("a website: http(s) on a public host, no social or delivery pages", () => {
    expect(venueWebsite("https://grandkitchen.com/menu")).toBe("https://grandkitchen.com/menu");
    expect(venueWebsite("grandkitchen.com")).toBe("https://grandkitchen.com/");
    for (const bad of ["https://www.instagram.com/grandkitchen", "https://m.facebook.com/grand", "https://www.doordash.com/store/grand", "https://linktr.ee/grand", "ftp://grand.com", "http://192.168.1.1/", "https://grand.local/", "https://user:pw@grand.com/", "not a url"]) {
      expect(venueWebsite(bad), bad).toBeNull();
    }
  });

  it("a domain names the venue by a distinctive word of its name, or all of a short one", () => {
    expect(domainNamesVenue("www.morgensternsnyc.com", matchKey("Morgenstern's Finest Ice Cream"))).toBe(true);
    expect(domainNamesVenue("grabsteinsbagels.square.site", matchKey("Grabstein's Bagels"))).toBe(true);
    expect(domainNamesVenue("nymag.com", matchKey("Toad Hall"))).toBe(false);
    expect(domainNamesVenue("www.randomhousebooks.com", matchKey("The Chai Spot"))).toBe(false);
    // "pizza" is in every pizzeria's domain.
    expect(domainNamesVenue("www.pizzahut.com", matchKey("Pizza Palace"))).toBe(false);
    expect(domainNamesVenue("bar13.com", matchKey("Bar 13"))).toBe(true);
  });

  it("a phone: North American numbers formatted, others kept with their +, junk dropped", () => {
    expect(venuePhone("2125550100")).toBe("+1 212-555-0100");
    expect(venuePhone("+1 (212) 555-0100")).toBe("+1 212-555-0100");
    expect(venuePhone("12125550100")).toBe("+1 212-555-0100");
    expect(venuePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(venuePhone("555-0100")).toBeNull();
    expect(venuePhone("0125550100")).toBeNull();
  });
});

describe("the box to read", () => {
  it("covers every venue with the margin on each side", () => {
    const b = bboxAround([AT, north(1000)], 150);
    expect(b.south).toBeCloseTo(AT.lat - 150 / 111_320, 4);
    expect(b.north).toBeCloseTo(north(1150).lat, 4);
    expect(b.east - AT.lon).toBeGreaterThan(150 / 111_320);
    expect(() => bboxAround([], 150)).toThrow(/no venues/);
  });
});
