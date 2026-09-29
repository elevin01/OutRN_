import { describe, expect, it } from "vitest";
import { matchKey } from "@outrn/core";
import type { OverturePlace } from "@outrn/sources";
import { bboxAround, chainName, claimsFor, liveReadBox, domainNamesVenue, genericName, KNOWN_CHAINS, kindEstimates, matchVenue, mostlyLatin, namesake, newPlaceGate, placeFacts, PlaceIndex, venuePhone, venueWebsite, type MatchVenue, type OvertureMatch } from "./overture.js";

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

  it("a category named after an inherited property is treated as any other unknown kind, never a crash", () => {
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      expect(() => match(venue("Grand Kitchen", key as MatchVenue["category"]), place({ name: "Grand Kitchen Bar" })), key).not.toThrow();
      expect(match(venue("Grand Kitchen", key as MatchVenue["category"]), place({ name: "Grand Kitchen Bar" })), key).toHaveLength(1);
    }
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
    const closed = { status: "permanently_closed", statusSignal: 1, statusUpdatedAt: "2026-06-26T16:25:14.000Z" } as const;
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
    const closed: Partial<OverturePlace> = { status: "permanently_closed", statusSignal: 1, statusUpdatedAt: "2026-06-26T16:25:14.000Z", confidence: 0.9, datasets: ["meta"] };
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

    it("a signal with its own date, and the closure dated by it alone", () => {
      // Undated, it would read as new on every run and outrank a founder's later check.
      expect(closes(GK, m({ ...closed, statusUpdatedAt: null }))).toBe(false);
      expect(closes(GK, m({ ...closed, statusUpdatedAt: null, updatedAt: "2026-09-01T00:00:00.000Z" }))).toBe(false);
      const claim = claimsFor(GK, [m({ ...closed, updatedAt: "2026-09-01T00:00:00.000Z" })], none).find((c) => c.attribute === "business_status");
      expect(claim?.sourceUpdatedAt).toEqual(new Date("2026-06-26T16:25:14.000Z"));
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

describe("the box a live read covers", () => {
  it("is the venues other sources gave us, and a margin: venues made from Overture's places never widen it", () => {
    const supply = [
      { id: "a", lat: 40.72, lon: -74.0 },
      { id: "b", lat: 40.73, lon: -73.99 },
    ];
    const box = liveReadBox(supply, new Set());
    expect(box).toEqual(bboxAround(supply, 150));
    // Round after round, a place added at the very edge of the last read is a venue of Overture's own:
    // the next read's box stays where it was.
    const venues = [...supply];
    const made = new Set<string>();
    let b = box;
    for (let i = 0; i < 5; i++) {
      const edge = [{ id: `ne${i}`, lat: b.north - 1e-6, lon: b.east - 1e-6 }, { id: `sw${i}`, lat: b.south + 1e-6, lon: b.west + 1e-6 }];
      venues.push(...edge);
      for (const e of edge) made.add(e.id);
      b = liveReadBox(venues, made);
      expect(b, `round ${i + 1}`).toEqual(box);
    }
    // Without the rule, the same rounds walk the box outward.
    expect(bboxAround(venues, 150).north).toBeGreaterThan(box.north);
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

describe("places OSM lacks", () => {
  // A place that can be checked: a phone number (see contactable).
  const np = (over: Partial<OverturePlace> = {}) => place({ phones: ["2125550100"], ...over });

  it("only a confident, open place of a kind we map, not from a company register alone", () => {
    expect(newPlaceGate(np({ name: "Gotan", category: "coffee_shop" }))).toEqual({ category: "cafe" });
    expect(newPlaceGate(np({ name: "Sorso", category: "lounge" }))).toEqual({ category: "bar" });
    expect(newPlaceGate(np({ name: "A.I.R. Gallery", category: "art_gallery" }))).toEqual({ category: "gallery" });
    expect(newPlaceGate(np({ name: "Gotan", status: "permanently_closed" }))).toEqual({ skip: "status" });
    expect(newPlaceGate(np({ name: "Gotan", status: "temporarily_closed" }))).toEqual({ skip: "status" });
    expect(newPlaceGate(np({ name: "Gotan", confidence: 0.79 }))).toEqual({ skip: "confidence" });
    expect(newPlaceGate(np({ name: "Gotan", confidence: null }))).toEqual({ skip: "confidence" });
    expect(newPlaceGate(np({ name: "Gotan", datasets: ["BrightQuery"] }))).toEqual({ skip: "register" });
    expect(newPlaceGate(np({ name: "Gotan", datasets: ["BrightQuery", "meta"] }))).toEqual({ category: "restaurant" });
    // Kinds OSM maps well (parks, museums, libraries, theatres), kinds that say too little, and fast food (the founder's call).
    for (const category of ["park", "museum", "library", "theatre_venue", "movie_theater", "fast_food_restaurant", "food_and_beverage_store", "historic_site", "specialty_store", "playground", "constructor"]) {
      expect(newPlaceGate(np({ name: "Gotan", category })), category).toEqual({ skip: "category" });
    }
  });

  it("a way to check first: a phone, or a website that is the place's own", () => {
    expect(newPlaceGate(place({ name: "Gotan" }))).toEqual({ skip: "contact" });
    expect(newPlaceGate(place({ name: "Gotan", phones: ["not a phone"] }))).toEqual({ skip: "contact" });
    expect(newPlaceGate(place({ name: "Gotan", websites: ["https://www.timeout.com/newyork/restaurants/best-new"] }))).toEqual({ skip: "contact" });
    expect(newPlaceGate(place({ name: "Gotan", websites: ["https://www.instagram.com/gotan"] }))).toEqual({ skip: "contact" });
    expect(newPlaceGate(place({ name: "Gotan", websites: ["https://gotannyc.com/"] }))).toEqual({ category: "restaurant" });
    expect(newPlaceGate(place({ name: "Gotan", phones: ["+1 (212) 555-0142"] }))).toEqual({ category: "restaurant" });
  });

  it("a record not updated in two years before the read is not news about a place open now", () => {
    const asOf = new Date("2026-09-29T00:00:00Z");
    expect(newPlaceGate(np({ name: "Formerly Crow's", category: "bar", updatedAt: "2013-01-29T05:21:15.170Z" }), KNOWN_CHAINS, asOf)).toEqual({ skip: "stale" });
    expect(newPlaceGate(np({ name: "Gotan", updatedAt: null }), KNOWN_CHAINS, asOf)).toEqual({ skip: "stale" });
    expect(newPlaceGate(np({ name: "Gotan", updatedAt: "2025-01-01T00:00:00.000Z" }), KNOWN_CHAINS, asOf)).toEqual({ category: "restaurant" });
  });

  it("a name mostly in another script is a record misplaced from abroad", () => {
    expect(mostlyLatin("Gotan")).toBe(true);
    expect(mostlyLatin("Bánh Mì Cô Út")).toBe(true);
    expect(mostlyLatin("ร้านโรตีบังดัน สาขา2 -เฉวง")).toBe(false);
    expect(mostlyLatin("Juisangkong cafe จุ้ยแสงคงคาเฟ่ คาเฟ่ในดงสละ")).toBe(false);
    expect(mostlyLatin("98")).toBe(false);
    expect(newPlaceGate(np({ name: "ร้านโรตีบังดัน สาขา2 -เฉวง" }))).toEqual({ skip: "name" });
  });

  it("a name that is a name: not generic words, an address, a street, a company, a shop, or an artist's studio", () => {
    for (const name of ["Deli & Grocery", "Pizza", "142 Sullivan St", "12A Orchard Street", "Grove st", "MoMoya 4 inc", "Lucky Star LLC", "S1 Grocers & Gourmet Deli", "Stuyvesant Gourmet Deli", "Ferris Mini Market and Deli", "Essex Pharmacy", "  "]) {
      expect(newPlaceGate(np({ name })), name).toEqual({ skip: "name" });
    }
    expect(newPlaceGate(np({ name: "Nancy Pantirer Studio", category: "art_gallery" }))).toEqual({ skip: "name" });
    // A restaurant may be named for its address; a studio restaurant is a restaurant.
    expect(newPlaceGate(np({ name: "87 Ludlow" }))).toEqual({ category: "restaurant" });
    expect(newPlaceGate(np({ name: "Studio Makan" }))).toEqual({ category: "restaurant" });
  });

  it("chains are left out: known ones, brands OSM tags, and a chain's name with more after it", () => {
    for (const name of ["Starbucks", "Dunkin'", "Baskin-Robbins", "Häagen-Dazs & Cinnabon", "McDonald's"]) expect(newPlaceGate(np({ name })), name).toEqual({ skip: "chain" });
    const withOsm = new Set([...KNOWN_CHAINS, matchKey("Joe's Pizza")]);
    expect(newPlaceGate(np({ name: "Joe's Pizza" }), withOsm)).toEqual({ skip: "chain" });
    expect(newPlaceGate(np({ name: "Joe's Pizza" }))).toEqual({ category: "restaurant" });
    // Whole words from the start: "Starbucks" does not take "Starbuck Diner"; a brand inside a name is not its chain.
    expect(chainName(matchKey("Starbuck Diner"), KNOWN_CHAINS)).toBe(false);
    expect(chainName(matchKey("Not Starbucks"), KNOWN_CHAINS)).toBe(false);
  });

  it("the kind from the name when Overture only says restaurant: ice cream is dessert, a bakery or coffee bar a café", () => {
    expect(newPlaceGate(np({ name: "Sweet Moon Ice Cream" }))).toEqual({ category: "dessert" });
    expect(newPlaceGate(np({ name: "Eileen's Special Cheesecake" }))).toEqual({ category: "dessert" });
    expect(newPlaceGate(np({ name: "Topps Bakery" }))).toEqual({ category: "cafe" });
    expect(newPlaceGate(np({ name: "Voyager Espresso", category: "casual_eatery" }))).toEqual({ category: "cafe" });
    // Only for a restaurant: a bar named for its coffee is still a bar.
    expect(newPlaceGate(np({ name: "Coffee Bar Nights", category: "bar" }))).toEqual({ category: "bar" });
  });

  it("a namesake is left out: the same name within 500 m, or a distinctive word in common within 100 m", () => {
    expect(namesake("Hunan 3", "Hunan III", 30)).toBe(true);
    expect(namesake("Essex Kitchen", "Essex Kitchen", 300)).toBe(true);
    expect(namesake("Essex Kitchen", "Essex Kitchen", 600)).toBe(false);
    expect(namesake("The Grand Noodle House", "Grand Kitchen", 80)).toBe(true);
    expect(namesake("The Grand Noodle House", "Grand Kitchen", 150)).toBe(false);
    // Generic words alone tie nothing: "Thai Kitchen" beside "Italian Kitchen" are two places.
    expect(namesake("Thai Kitchen", "Italian Kitchen", 20)).toBe(false);
    expect(namesake("Sorso", "Gotan", 5)).toBe(false);
  });

  it("each kind gets the estimates the OSM rules give it, from its bare tags", () => {
    const kinds = ["restaurant", "cafe", "dessert", "bar", "gallery", "live_music", "nightclub", "arcade", "market"] as const;
    for (const k of kinds) expect(() => kindEstimates(k), k).not.toThrow();
    const of = (k: (typeof kinds)[number], attribute: string) => kindEstimates(k).find((e) => e.attribute === attribute)?.value;
    expect(of("cafe", "admission")).toEqual({ requirement: "walk_in" });
    expect(of("gallery", "admission")).toEqual({ requirement: "walk_in" });
    expect(of("gallery", "price")).toMatchObject({ free: true });
    expect(of("bar", "age_limit")).toEqual({ minAge: 21 });
    expect(of("live_music", "admission")).toEqual({ requirement: "ticket" });
    expect(kindEstimates("restaurant").every((e) => e.attribute !== "name" && e.attribute !== "category")).toBe(true);
  });

  it("a new place's facts: its name and kind, status and contact details as for any match, and its kind's estimates", () => {
    const now = new Date("2026-09-29T00:00:00Z");
    const p = place({ id: "ovt-gotan", name: "Gotan", category: "coffee_shop", websites: ["https://www.instagram.com/gotan", "https://gotannyc.com/"], phones: ["2125550123"] });
    const f = placeFacts("venue-1", p, "cafe", "run-1", now);
    const by = (a: string) => f.find((x) => x.attribute === a);
    expect(by("name")).toMatchObject({ value: { value: "Gotan" }, evidenceClass: "published", sourceId: "overture", lineageGroup: "overture", confidence: 0.8 });
    expect(by("category")).toMatchObject({ value: { value: "cafe" }, evidence: "Overture place ovt-gotan: coffee_shop" });
    expect(by("business_status")).toMatchObject({ value: { status: "operating" }, confidence: 0.6 });
    expect(by("website")).toMatchObject({ value: { value: "https://gotannyc.com/" } });
    expect(by("phone")).toMatchObject({ value: { value: "+1 212-555-0123" } });
    expect(by("admission")).toMatchObject({ value: { requirement: "walk_in" }, evidenceClass: "estimate" });
    expect(by("opening_hours")).toBeUndefined();
    // One claim per attribute: the place's own status, never a kind estimate beside it.
    expect(f.filter((x) => x.attribute === "business_status")).toHaveLength(1);
    expect(new Set(f.map((x) => x.attribute)).size).toBe(f.length);
    // Without Overture's signal or a confident record, no status at all: still no estimate in its place.
    expect(placeFacts("venue-1", { ...p, confidence: 0.5 }, "cafe", null, now).some((x) => x.attribute === "business_status")).toBe(false);
  });
});
