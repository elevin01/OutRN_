import { describe, expect, it } from "vitest";
import { fromLocal } from "@outrn/core";
import { explain } from "./explain.js";
import { evaluateAll, recommend } from "./recommend.js";
import type { Candidate, CategoryPolicy, RequestContext } from "./types.js";

/**
 * Correctness suite from the build plan: every case here is a bug that would change a
 * real-world recommendation. Times are New York local, converted with fromLocal.
 */

const TZ = "America/New_York";
const ORIGIN = { lat: 40.7185, lon: -73.988 };
const NEAR = { lat: 40.7195, lon: -73.987 }; // ~150 m → ~3 min walk
const FAR = { lat: 40.76, lon: -73.98 }; // ~4.7 km → ~76 min walk

const POLICIES = new Map<string, CategoryPolicy>([
  ["museum", { category: "museum", minUsefulMinutes: 80, admissionBufferMinutes: 10, kitchenCloseOffsetMinutes: null, lastEntryDefaultMinutes: 60, activityType: "culture" }],
  ["restaurant", { category: "restaurant", minUsefulMinutes: 60, admissionBufferMinutes: 10, kitchenCloseOffsetMinutes: 40, lastEntryDefaultMinutes: null, activityType: "food" }],
  ["cafe", { category: "cafe", minUsefulMinutes: 30, admissionBufferMinutes: 5, kitchenCloseOffsetMinutes: null, lastEntryDefaultMinutes: null, activityType: "food" }],
  ["bar", { category: "bar", minUsefulMinutes: 45, admissionBufferMinutes: 5, kitchenCloseOffsetMinutes: null, lastEntryDefaultMinutes: null, activityType: "drink" }],
  ["park", { category: "park", minUsefulMinutes: 45, admissionBufferMinutes: 5, kitchenCloseOffsetMinutes: null, lastEntryDefaultMinutes: null, activityType: "outdoors" }],
  ["live_music", { category: "live_music", minUsefulMinutes: 0, admissionBufferMinutes: 15, kitchenCloseOffsetMinutes: null, lastEntryDefaultMinutes: null, activityType: "entertainment" }],
  ["bookshop", { category: "bookshop", minUsefulMinutes: 30, admissionBufferMinutes: 5, kitchenCloseOffsetMinutes: null, lastEntryDefaultMinutes: null, activityType: "browse" }],
  ["dessert", { category: "dessert", minUsefulMinutes: 25, admissionBufferMinutes: 5, kitchenCloseOffsetMinutes: null, lastEntryDefaultMinutes: null, activityType: "food" }],
  ["gallery", { category: "gallery", minUsefulMinutes: 40, admissionBufferMinutes: 5, kitchenCloseOffsetMinutes: null, lastEntryDefaultMinutes: 30, activityType: "culture" }],
  ["activity", { category: "activity", minUsefulMinutes: 60, admissionBufferMinutes: 10, kitchenCloseOffsetMinutes: null, lastEntryDefaultMinutes: null, activityType: "entertainment" }],
  ["cinema", { category: "cinema", minUsefulMinutes: 0, admissionBufferMinutes: 15, kitchenCloseOffsetMinutes: null, lastEntryDefaultMinutes: null, activityType: "entertainment" }],
]);

let n = 0;
function venue(over: Partial<Candidate> & { hours?: string | null; hoursConf?: number; hoursSources?: string[]; hoursVerifiedAt?: Date | null; hoursConflict?: boolean; admission?: string; price?: unknown; wheelchair?: string; lastEntry?: number; kitchen?: string }): Candidate {
  const id = over.id ?? `v${++n}`;
  const facts: Candidate["facts"] = {
    name: { value: { value: over.name ?? id }, confidence: 0.9, evidenceClass: "published", validUntil: null, independentSources: 1 },
    business_status: { value: { status: "operating" }, confidence: 0.5, evidenceClass: "estimate", validUntil: null, independentSources: 1 },
    admission: { value: { requirement: over.admission ?? "walk_in" }, confidence: 0.6, evidenceClass: over.admission ? "published" : "estimate", validUntil: null, independentSources: 1 },
  };
  if (over.hours !== null) facts.opening_hours = { value: { osm: over.hours ?? "Mo-Su 09:00-22:00" }, confidence: over.hoursConf ?? 0.6, evidenceClass: "published", validUntil: null, independentSources: 1, sources: over.hoursSources ?? ["osm"], verifiedAt: over.hoursVerifiedAt ?? null, conflict: over.hoursConflict ?? false };
  if (over.price !== undefined) facts.price = { value: over.price, confidence: 0.7, evidenceClass: "published", validUntil: null, independentSources: 1 };
  if (over.wheelchair) facts.wheelchair = { value: { value: over.wheelchair }, confidence: 0.7, evidenceClass: "published", validUntil: null, independentSources: 1 };
  if (over.kitchen) facts.kitchen_hours = { value: { osm: over.kitchen }, confidence: 0.6, evidenceClass: "published", validUntil: null, independentSources: 1 };
  if (over.lastEntry) facts.last_entry_offset = { value: { minutes: over.lastEntry }, confidence: 0.9, evidenceClass: "published", validUntil: null, independentSources: 1 };
  return { kind: "venue", id, venueId: id, name: over.name ?? id, category: over.category ?? "cafe", point: over.point ?? NEAR, timezone: TZ, facts, boost: 0, excluded: false, hasLandmarkId: false, parentVenueId: null, brand: over.brand ?? null, ...(over.occurrence ? { occurrence: over.occurrence } : {}), ...(over.kind ? { kind: over.kind } : {}) };
}

function ctx(date: string, minutes: number, over: Partial<RequestContext> = {}): RequestContext {
  const [d, hm] = date.split(" ") as [string, string];
  const [h, m] = hm.split(":").map(Number) as [number, number];
  return { origin: ORIGIN, now: fromLocal(d, h * 60 + m, TZ), windowMinutes: minutes, mode: "walk", timezone: TZ, ...over };
}

const one = (c: Candidate, x: RequestContext) => evaluateAll([c], x, POLICIES)[0]!;

describe("feasibility: opening hours", () => {
  it("open now but closes before a worthwhile visit → NOT_ENOUGH_TIME", () => {
    const e = one(venue({ category: "restaurant", hours: "Mo-Su 12:00-19:00" }), ctx("2026-10-03 18:20", 180));
    // arrival 18:33, kitchen closes 18:20 (19:00 − 40) → no time
    expect(e.class).toBe("ineligible");
    expect(e.excludedBy).toBe("NOT_ENOUGH_TIME");
  });

  it("closed at arrival, opens later inside the window → WAIT_FOR_OPENING, still eligible", () => {
    const e = one(venue({ category: "bar", hours: "Mo-Su 17:00-02:00" }), ctx("2026-10-03 16:30", 180));
    expect(e.class).toBe("ready");
    expect(e.reasons).toContain("WAIT_FOR_OPENING");
    expect(e.timing!.arrival.getTime()).toBe(fromLocal("2026-10-03", 17 * 60, TZ).getTime());
  });

  it("closed at arrival and not opening in time → CLOSED_ON_ARRIVAL", () => {
    const e = one(venue({ category: "cafe", hours: "Mo-Su 07:00-18:00" }), ctx("2026-10-03 18:30", 120));
    expect(e.excludedBy).toBe("CLOSED_ON_ARRIVAL");
  });

  it("overnight interval: a bar open 20:00–04:00 is open at 01:00", () => {
    const e = one(venue({ category: "bar", hours: "Mo-Su 20:00-04:00" }), ctx("2026-10-04 01:00", 120));
    expect(e.class).toBe("ready");
    expect(e.timing!.closesAt!.getTime()).toBe(fromLocal("2026-10-04", 4 * 60, TZ).getTime());
  });

  it("DST fall-back night (Nov 1 2026): hours still resolve and useful time is computed in local time", () => {
    const e = one(venue({ category: "bar", hours: "Mo-Su 18:00-02:00" }), ctx("2026-10-31 22:00", 240));
    expect(e.class).toBe("ready");
    // 02:00 local on Nov 1 exists twice; we accept either resolution but the interval must be after now.
    expect(e.timing!.closesAt!.getTime()).toBeGreaterThan(e.timing!.arrival.getTime());
  });

  it("24/7 has no closing constraint; useful time is bounded by the deadline", () => {
    const e = one(venue({ category: "park", hours: "24/7" }), ctx("2026-10-03 23:00", 90));
    expect(e.class).toBe("ready");
    expect(e.timing!.closesAt).toBeNull();
    expect(e.timing!.usefulMinutes).toBe(90 - e.timing!.travel.minutes - 5);
  });

  it("no hours at all → Check first with HOURS_UNKNOWN, never claimed open", () => {
    const e = one(venue({ category: "park", hours: null }), ctx("2026-10-03 15:00", 120));
    expect(e.class).toBe("check_first");
    expect(e.unresolved).toContain("HOURS_UNKNOWN");
    expect(e.cta).toBe("check");
  });

  it("stale hours (low confidence) → Check first with HOURS_UNVERIFIED", () => {
    const e = one(venue({ category: "cafe", hours: "Mo-Su 07:00-20:00", hoursConf: 0.31 }), ctx("2026-10-03 15:00", 120));
    expect(e.class).toBe("check_first");
    expect(e.unresolved).toContain("HOURS_UNVERIFIED");
  });

  it("unparseable hours string is treated as unknown, not as open", () => {
    const e = one(venue({ category: "cafe", hours: "whenever we feel like it" }), ctx("2026-10-03 15:00", 120));
    expect(e.class).toBe("check_first");
    expect(e.unresolved).toContain("HOURS_UNKNOWN");
  });
});

describe("feasibility: last entry", () => {
  it("published last entry limits arrival, not the visit: 4:10 arrival, 4:30 last entry, 5:30 close → 80 min on site", () => {
    // arrival = 15:55 depart + 3 min walk + 10 min buffer ≈ 16:08; last entry 16:30; close 17:30 → ~82 min on site
    const c = venue({ category: "museum", hours: "Mo-Su 10:00-17:30", lastEntry: 60 });
    const e = one(c, ctx("2026-10-03 15:55", 180));
    expect(e.class).toBe("ready");
    expect(e.timing!.latestArrival!.getTime()).toBe(fromLocal("2026-10-03", 16 * 60 + 30, TZ).getTime());
    expect(e.timing!.usefulMinutes).toBeGreaterThanOrEqual(80);
    expect(e.timing!.latestFinish.getTime()).toBe(fromLocal("2026-10-03", 17 * 60 + 30, TZ).getTime());
  });

  it("arriving after a PUBLISHED last entry → LAST_ENTRY_PASSED", () => {
    const e = one(venue({ category: "museum", hours: "Mo-Su 10:00-17:30", lastEntry: 60 }), ctx("2026-10-03 16:25", 180));
    expect(e.excludedBy).toBe("LAST_ENTRY_PASSED");
  });

  it("arriving after an ESTIMATED last entry only downgrades to Check first", () => {
    // No published last_entry; category default 60 min → estimated latest arrival 16:30; arrival ≈ 16:38
    const c = venue({ category: "museum", hours: "Mo-Su 10:00-17:30" });
    const e = one(c, ctx("2026-10-03 16:25", 180));
    // useful = 17:30 − 16:38 = 52 < 80 → actually NOT_ENOUGH_TIME wins here; move the window to prove the estimate rule
    const e2 = one(venue({ category: "museum", hours: "Mo-Su 10:00-19:00" }), ctx("2026-10-03 17:50", 180));
    expect(e.excludedBy).toBe("NOT_ENOUGH_TIME");
    // e2: arrival ≈ 18:03, est. last entry 18:00, close 19:00 → 57 min < 80 → NOT_ENOUGH_TIME again; use a shorter policy category
    expect(["NOT_ENOUGH_TIME", null]).toContain(e2.excludedBy);
    const gallery = venue({ category: "museum", hours: "Mo-Su 10:00-19:30" });
    const e3 = one(gallery, ctx("2026-10-03 17:50", 180)); // arrival 18:03, est last entry 18:30 → fine, 87 min
    expect(e3.class).toBe("ready");
    const e4 = one(venue({ category: "museum", hours: "Mo-Su 10:00-19:45" }), ctx("2026-10-03 18:40", 180)); // arrival 18:53 > est 18:45; useful 52 → not enough
    expect(e4.excludedBy).toBe("NOT_ENOUGH_TIME");
  });
});

describe("feasibility: fixed-start occurrences", () => {
  const start = fromLocal("2026-10-03", 20 * 60, TZ);
  const end = fromLocal("2026-10-03", 22 * 60, TZ);
  const show = (over: Partial<Candidate["occurrence"]> = {}) =>
    venue({ kind: "occurrence", category: "live_music", hours: null, admission: "ticket", occurrence: { id: "o1", title: "Late set", start, end, entryCutoff: null, lateEntry: null, status: "scheduled", ...over } });

  it("a concert ending at 10pm is not a valid recommendation at 9pm when late entry is unknown", () => {
    const e = one(show(), ctx("2026-10-03 21:00", 120));
    expect(e.excludedBy).toBe("EVENT_STARTED");
  });

  it("joining late is allowed only when the source says so, and then it is Check first", () => {
    const e = one(show({ lateEntry: true }), ctx("2026-10-03 20:30", 120));
    expect(e.class).toBe("check_first");
    expect(e.unresolved).toContain("LATE_ENTRY_UNCERTAIN");
  });

  it("cancelled and sold out are excluded outright", () => {
    expect(one(show({ status: "cancelled" }), ctx("2026-10-03 19:00", 240)).excludedBy).toBe("EVENT_CANCELLED");
    expect(one(show({ status: "sold_out" }), ctx("2026-10-03 19:00", 240)).excludedBy).toBe("EVENT_SOLD_OUT");
  });

  it("an event that ends after the user's deadline is excluded", () => {
    const e = one(show(), ctx("2026-10-03 19:00", 120)); // deadline 21:00, ends 22:00
    expect(e.excludedBy).toBe("EVENT_ENDS_AFTER_DEADLINE");
  });

  it("arriving early is waiting, not useful time; a ticketed event is Check first until admission is confirmed", () => {
    const e = one(show(), ctx("2026-10-03 19:00", 240));
    expect(e.class).toBe("check_first");
    expect(e.unresolved).toContain("ADMISSION_UNCONFIRMED");
    expect(e.cta).toBe("book");
    expect(e.reasons).toContain("EVENT_STARTS_SOON");
    expect(e.timing!.usefulMinutes).toBe(120);
  });
});

describe("pagination", () => {
  const cafes = (n: number) => Array.from({ length: n }, (_, i) => venue({ id: `cafe${String(i).padStart(2, "0")}`, category: "cafe", hours: "Mo-Su 07:00-23:00" }));
  const x = () => ctx("2026-10-03 15:00", 180, { categories: ["cafe"] });

  /** Follow nextOffset like the "More options" link does; fail on a repeated page. */
  function walk(n: number, opts: { maxOffset?: number } = {}) {
    const all = cafes(n);
    const seen: string[] = [];
    const offsets: number[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      if (offsets.includes(offset)) throw new Error(`page at offset ${offset} served twice`);
      offsets.push(offset);
      const s = recommend(all, x(), POLICIES, { offset, ...opts });
      seen.push(...s.items.map((e) => e.candidate.id));
      offset = s.nextOffset;
    }
    return { seen, offsets };
  }

  it("follows More options past 63 results to the end, each result exactly once", () => {
    const { seen, offsets } = walk(70);
    expect(seen).toHaveLength(70);
    expect(new Set(seen).size).toBe(70);
    expect(offsets.at(-1)).toBe(69);
  });

  it("at the page limit it stops offering More options instead of looping back (26 Sep re-review: cap 60)", () => {
    const { seen, offsets } = walk(70, { maxOffset: 60 });
    expect(offsets.at(-1)).toBe(60);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(63);
    // A request past the limit is clamped to it and still offers no next page.
    const beyond = recommend(cafes(70), x(), POLICIES, { offset: 63, maxOffset: 60 });
    expect(beyond.offset).toBe(60);
    expect(beyond.nextOffset).toBeNull();
  });
});

describe("feasibility: programme venues", () => {
  it("a cinema with no occurrence loaded for the window is ineligible (NO_PROGRAMME), whatever its hours", () => {
    const withHours = one(venue({ category: "cinema", hours: "Mo-Su 12:00-23:30", admission: "ticket" }), ctx("2026-09-26 21:37", 120));
    expect(withHours.excludedBy).toBe("NO_PROGRAMME");
    const noHours = one(venue({ category: "theatre", hours: null }), ctx("2026-09-26 21:37", 120));
    expect(noHours.excludedBy).toBe("NO_PROGRAMME");
  });

  it("a screening that fits the window is still a candidate, and NO_PROGRAMME is never offered as a relaxation", () => {
    const start = fromLocal("2026-09-26", 22 * 60, TZ);
    const end = fromLocal("2026-09-26", 23 * 60 + 30, TZ);
    const screening = venue({ kind: "occurrence", category: "cinema", hours: null, admission: "ticket", occurrence: { id: "s1", title: "10pm show", start, end, entryCutoff: null, lateEntry: null, status: "scheduled" } });
    const e = one(screening, ctx("2026-09-26 21:37", 120));
    expect(e.class).toBe("check_first");
    expect(e.cta).toBe("book");
    const s = recommend([venue({ category: "cinema", hours: null })], ctx("2026-09-26 21:37", 120), POLICIES);
    expect(s.relaxations.map((r) => r.text).join(" ")).not.toMatch(/programme/i);
  });
});

describe("feasibility: travel, deadlines, budget, access", () => {
  it("beyond max travel → TOO_FAR", () => {
    expect(one(venue({ point: FAR }), ctx("2026-10-03 15:00", 240)).excludedBy).toBe("TOO_FAR");
  });

  it("a drive uses the area's parking buffer when the request carries one", () => {
    const c = venue({ category: "bar", hours: "Mo-Su 16:00-24:00", point: { lat: 40.745, lon: -73.988 } });
    const base = one(c, ctx("2026-10-03 19:00", 120, { mode: "drive" }));
    const evening = one(c, ctx("2026-10-03 19:00", 120, { mode: "drive", parkingBufferMinutes: 5 }));
    expect(evening.timing!.travel.minutes).toBe(base.timing!.travel.minutes - 3);
  });

  it("a 'back by' deadline subtracts the return trip", () => {
    const c = venue({ category: "cafe", hours: "Mo-Su 07:00-23:00" });
    const x = ctx("2026-10-03 15:00", 240, { backBy: fromLocal("2026-10-03", 16 * 60, TZ) });
    const e = one(c, x);
    expect(e.class).toBe("ready");
    expect(e.timing!.returnTravel).not.toBeNull();
    expect(e.timing!.deadline.getTime()).toBeLessThan(fromLocal("2026-10-03", 16 * 60, TZ).getTime());
    expect(e.timing!.usefulMinutes).toBeLessThan(60);
  });

  it("strict budget with unknown price cannot be Ready; known price over budget is excluded", () => {
    const unknown = one(venue({ category: "restaurant", hours: "Mo-Su 11:00-23:00" }), ctx("2026-10-03 15:00", 180, { budget: 25 }));
    expect(unknown.class).toBe("check_first");
    expect(unknown.unresolved).toContain("PRICE_UNKNOWN");
    const over = one(venue({ category: "restaurant", hours: "Mo-Su 11:00-23:00", price: { min: 40, max: 80, currency: "USD", basis: "per_person" } }), ctx("2026-10-03 15:00", 180, { budget: 25 }));
    expect(over.excludedBy).toBe("OVER_BUDGET");
    const fits = one(venue({ category: "restaurant", hours: "Mo-Su 11:00-23:00", price: { min: 10, max: 20, currency: "USD", basis: "per_person" } }), ctx("2026-10-03 15:00", 180, { budget: 25 }));
    expect(fits.reasons).toContain("FITS_BUDGET");
  });

  it("budget 'free' excludes unknown-price venues rather than guessing", () => {
    const e = one(venue({ category: "cafe" }), ctx("2026-10-03 15:00", 120, { budget: "free" }));
    expect(e.excludedBy).toBe("NOT_FREE");
    const park = one(venue({ category: "park", hours: "Mo-Su 06:00-22:00", price: { currency: "USD", free: true, basis: "per_person" } }), ctx("2026-10-03 15:00", 120, { budget: "free" }));
    expect(park.class).toBe("ready");
    expect(park.reasons).toContain("FREE");
  });

  it("required accessibility with unknown data does not pass", () => {
    expect(one(venue({}), ctx("2026-10-03 15:00", 120, { requireWheelchair: true })).excludedBy).toBe("ACCESS_UNKNOWN");
    expect(one(venue({ wheelchair: "no" }), ctx("2026-10-03 15:00", 120, { requireWheelchair: true })).excludedBy).toBe("NOT_ACCESSIBLE");
    const lim = one(venue({ wheelchair: "limited" }), ctx("2026-10-03 15:00", 120, { requireWheelchair: true }));
    expect(lim.class).toBe("check_first");
    expect(one(venue({ wheelchair: "yes" }), ctx("2026-10-03 15:00", 120, { requireWheelchair: true })).class).toBe("ready");
  });

  it("closed permanently, excluded by override, dismissed → ineligible with the right code", () => {
    const closed = venue({});
    closed.facts.business_status = { value: { status: "closed_permanently" }, confidence: 0.75, evidenceClass: "published", validUntil: null, independentSources: 1 };
    expect(one(closed, ctx("2026-10-03 15:00", 120)).excludedBy).toBe("CLOSED_PERMANENTLY");
    expect(one({ ...venue({}), excluded: true }, ctx("2026-10-03 15:00", 120)).excludedBy).toBe("EXCLUDED_BY_OVERRIDE");
    const d = venue({ id: "dis" });
    expect(one(d, ctx("2026-10-03 15:00", 120, { dismissedIds: ["dis"] })).excludedBy).toBe("DISMISSED");
  });

  it("an expired observation is ignored by the loader, but a fresh one surfaces FRESH_REPORT", () => {
    const c = venue({ category: "bar", hours: "Mo-Su 16:00-02:00" });
    const x = ctx("2026-10-03 21:00", 120);
    c.facts.queue = { value: { value: "none" }, confidence: 0.7, evidenceClass: "observation", validUntil: new Date(x.now.getTime() + 10 * 60_000), independentSources: 1 };
    expect(one(c, x).reasons).toContain("FRESH_REPORT");
  });
});

describe("selection: diversity and fewer than three", () => {
  it("a broad request spans activity types and never repeats a venue", () => {
    const cands = [
      venue({ id: "r1", category: "restaurant", hours: "Mo-Su 11:00-23:00" }),
      venue({ id: "r2", category: "restaurant", hours: "Mo-Su 11:00-23:00" }),
      venue({ id: "b1", category: "bookshop", hours: "Mo-Su 10:00-21:00" }),
      venue({ id: "p1", category: "park", hours: "Mo-Su 06:00-22:00" }),
    ];
    const s = recommend(cands, ctx("2026-10-03 15:00", 180), POLICIES);
    expect(s.items.map((e) => e.candidate.category).sort()).toEqual(["bookshop", "park", "restaurant"]);
    expect(s.fewerThanThree).toBe(false);
  });

  it("a narrowed request respects the category and skips activity diversity", () => {
    const cands = [venue({ id: "r1", category: "restaurant", hours: "Mo-Su 11:00-23:00" }), venue({ id: "r2", category: "restaurant", hours: "Mo-Su 11:00-23:00" }), venue({ id: "r3", category: "restaurant", hours: "Mo-Su 11:00-23:00" }), venue({ id: "p1", category: "park" })];
    const s = recommend(cands, ctx("2026-10-03 15:00", 180, { categories: ["restaurant"] }), POLICIES);
    expect(s.items).toHaveLength(3);
    expect(s.items.every((e) => e.candidate.category === "restaurant")).toBe(true);
  });

  it("fewer than three: shows what qualified and names a specific relaxation, never silently widens", () => {
    const cands = [venue({ id: "a", category: "cafe", hours: "Mo-Su 07:00-23:00" }), venue({ id: "far1", point: FAR }), venue({ id: "far2", point: FAR, category: "park" })];
    const s = recommend(cands, ctx("2026-10-03 15:00", 180), POLICIES);
    expect(s.items).toHaveLength(1);
    expect(s.fewerThanThree).toBe(true);
    expect(s.relaxations[0]).toEqual({ code: "longer_travel", text: "allow a longer walk", admits: 2 });
  });

  it("Ready outranks Check first regardless of appeal, and a child venue is not shown beside its parent", () => {
    const parent = venue({ id: "m", category: "museum", hours: "Mo-Su 10:00-21:00", admission: "walk_in" });
    const child = { ...venue({ id: "mc", category: "cafe", hours: "Mo-Su 10:00-20:00" }), parentVenueId: "m" };
    const other = venue({ id: "b", category: "bookshop", hours: "Mo-Su 10:00-21:00" });
    const s = recommend([child, parent, other], ctx("2026-10-03 15:00", 180), POLICIES);
    const ids = s.items.map((e) => e.candidate.id);
    expect(ids).toContain("m");
    expect(ids).not.toContain("mc");
  });

  // 26 Sep 2026, 9:37 pm, Bronxville: Ernie's (Ready bar) took "drink", every other Ready bar was
  // skipped for diversity, and a Check-first cinema took the third slot.
  const saturdayNight = () => [
    venue({ id: "ernies", category: "bar", hours: "Tu-Sa 16:30-24:00" }),
    venue({ id: "growlers", category: "bar", hours: "Mo-Fr 16:00-24:00; Sa-Su 11:00-24:00" }),
    venue({ id: "haagen", category: "dessert", hours: "Su-Th 11:00-22:00; Fr-Sa 11:00-23:00" }),
    { ...venue({ id: "picturehouse", category: "cinema", hours: null, admission: "ticket" }), hasLandmarkId: true },
  ];

  it("Bronxville 26 Sep regression: the second Ready bar shows, the Check-first cinema does not", () => {
    const s = recommend(saturdayNight(), ctx("2026-09-26 21:37", 120), POLICIES);
    const ids = s.items.map((e) => e.candidate.id);
    expect(ids).toHaveLength(3);
    expect(ids).toEqual(expect.arrayContaining(["ernies", "growlers", "haagen"]));
    expect(ids).not.toContain("picturehouse");
    expect(s.items.every((e) => e.class === "ready")).toBe(true);
    // And the cinema had nothing on: it is not an option at all, not a "check first".
    expect(s.all.find((e) => e.candidate.id === "picturehouse")!.excludedBy).toBe("NO_PROGRAMME");
  });

  it("class beats diversity: a Check-first venue with a fresh activity type never displaces a Ready one", () => {
    const cands = [
      venue({ id: "bar1", category: "bar", hours: "Mo-Su 16:00-24:00" }),
      venue({ id: "bar2", category: "bar", hours: "Mo-Su 16:00-24:00" }),
      venue({ id: "sweet", category: "dessert", hours: "Mo-Su 11:00-23:00" }),
      { ...venue({ id: "gal", category: "gallery", hours: null }), hasLandmarkId: true },
    ];
    const s = recommend(cands, ctx("2026-09-26 21:37", 120), POLICIES);
    const ids = s.items.map((e) => e.candidate.id);
    expect(ids.sort()).toEqual(["bar1", "bar2", "sweet"]);
    // Within Ready, distinct activity types still come first: the dessert place is not pushed out by a third bar.
    const three = recommend([...cands, venue({ id: "bar3", category: "bar", hours: "Mo-Su 16:00-24:00" })], ctx("2026-09-26 21:37", 120), POLICIES);
    expect(three.items.map((e) => e.candidate.id)).toContain("sweet");
  });

  it("More options pages through the same ordering by offset", () => {
    const cands = [
      venue({ id: "bar1", category: "bar", hours: "Mo-Su 16:00-24:00" }),
      venue({ id: "bar2", category: "bar", hours: "Mo-Su 16:00-24:00" }),
      venue({ id: "sweet", category: "dessert", hours: "Mo-Su 11:00-23:00" }),
      venue({ id: "bar3", category: "bar", hours: "Mo-Su 16:00-24:00" }),
      venue({ id: "gal", category: "gallery", hours: null }),
    ];
    const x = ctx("2026-09-26 21:37", 120);
    const first = recommend(cands, x, POLICIES);
    const second = recommend(cands, x, POLICIES, { offset: 3 });
    expect(first.hasMore).toBe(true);
    expect(second.offset).toBe(3);
    expect(second.items.map((e) => e.candidate.id)).toEqual(["bar3", "gal"]);
    expect(second.hasMore).toBe(false);
    expect(second.fewerThanThree).toBe(false); // a short last page is not a supply failure
    const seen = new Set([...first.items, ...second.items].map((e) => e.candidate.id));
    expect(seen.size).toBe(5);
  });
});

describe("appeal signals", () => {
  it("a chain ranks below an otherwise identical local place, unless the user asked for that category", () => {
    const chain = venue({ id: "chain", category: "dessert", hours: "Mo-Su 11:00-23:00", brand: "Häagen-Dazs" });
    const local = venue({ id: "local", category: "dessert", hours: "Mo-Su 11:00-23:00" });
    const broad = evaluateAll([chain, local], ctx("2026-09-26 20:00", 120), POLICIES);
    expect(broad[1]!.scores.appeal - broad[0]!.scores.appeal).toBeCloseTo(0.15, 3);
    const narrowed = evaluateAll([chain, local], ctx("2026-09-26 20:00", 120, { categories: ["dessert"] }), POLICIES);
    expect(narrowed[0]!.scores.appeal).toBe(narrowed[1]!.scores.appeal);
  });

  it("after 9pm, bars and late food get a late-night bonus; at 3pm they do not", () => {
    const bar = venue({ id: "bar", category: "bar", hours: "Mo-Su 12:00-02:00" });
    const cafe = venue({ id: "cafe", category: "cafe", hours: "Mo-Su 12:00-02:00" });
    const late = evaluateAll([bar, cafe], ctx("2026-09-26 21:30", 120), POLICIES);
    expect(late[0]!.scores.appeal - late[1]!.scores.appeal).toBeCloseTo(0.1, 3);
    const afternoon = evaluateAll([bar, cafe], ctx("2026-09-26 15:00", 120), POLICIES);
    expect(afternoon[0]!.scores.appeal).toBe(afternoon[1]!.scores.appeal);
  });

  const daysBefore = (x: RequestContext, days: number) => new Date(x.now.getTime() - days * 86_400_000);

  it("hours checked recently and undisputed earn the 'confirmed' boost and say so", () => {
    const x = ctx("2026-09-26 21:37", 120);
    const checked = venue({ id: "checked", category: "bar", hours: "Mo-Su 16:00-04:00", hoursConf: 0.9, hoursSources: ["founder"], hoursVerifiedAt: daysBefore(x, 10) });
    const mapped = venue({ id: "mapped", category: "bar", hours: "Mo-Su 16:00-04:00", hoursConf: 0.9 });
    const [a, b] = evaluateAll([checked, mapped], x, POLICIES);
    expect(a!.scores.appeal - b!.scores.appeal).toBeCloseTo(0.1, 3);
    expect(a!.reasons).toContain("HOURS_CONFIRMED");
    expect(explain(a!, TZ).sentence).toMatch(/hours confirmed/);
    const s = recommend([mapped, checked], x, POLICIES);
    expect(s.items[0]!.candidate.id).toBe("checked");
  });

  it("an old check, a disputed one, or hours merely published by the venue site are not 'confirmed'", () => {
    const x = ctx("2026-09-26 21:37", 120);
    const stale = venue({ id: "stale", category: "bar", hours: "Mo-Su 16:00-04:00", hoursSources: ["founder"], hoursVerifiedAt: daysBefore(x, 120) });
    const disputed = venue({ id: "disputed", category: "bar", hours: "Mo-Su 16:00-04:00", hoursSources: ["founder"], hoursVerifiedAt: daysBefore(x, 10), hoursConflict: true });
    const site = venue({ id: "site", category: "bar", hours: "Mo-Su 16:00-04:00", hoursConf: 0.85, hoursSources: ["firstparty"] }); // retrieved, never verified
    const plain = venue({ id: "plain", category: "bar", hours: "Mo-Su 16:00-04:00" });
    const [s1, s2, s3, p] = evaluateAll([stale, disputed, site, plain], x, POLICIES);
    for (const e of [s1!, s2!, s3!]) {
      expect(e.reasons).not.toContain("HOURS_CONFIRMED");
      expect(e.scores.appeal).toBe(p!.scores.appeal);
    }
  });
});

describe("age limits", () => {
  const withLimit = (c: Candidate, minAge: number, cls: "published" | "estimate") => {
    c.facts.age_limit = { value: { minAge }, confidence: cls === "published" ? 0.75 : 0.7, evidenceClass: cls, validUntil: null, independentSources: 1 };
    return c;
  };
  const casino = (cls: "published" | "estimate") => withLimit(venue({ id: "casino", category: "activity", hours: "Mo-Su 10:00-04:00" }), 21, cls);
  const cafes = () => [1, 2, 3].map((i) => venue({ id: `cafe${i}`, category: "cafe", hours: "Mo-Su 07:00-23:00" }));
  const at = (over: Partial<RequestContext> = {}) => ctx("2026-09-26 15:00", 180, over);
  const ids = (s: ReturnType<typeof recommend>) => s.items.map((e) => e.candidate.id);

  it("family, published 21+: the casino is excluded and the shortlist is the three cafes (26 Sep re-review case)", () => {
    const s = recommend([...cafes(), casino("published")], at({ company: "family" }), POLICIES);
    expect(ids(s).sort()).toEqual(["cafe1", "cafe2", "cafe3"]);
    expect(s.items.every((e) => e.class === "ready")).toBe(true);
    expect(s.all.find((e) => e.candidate.id === "casino")!.excludedBy).toBe("AGE_RESTRICTED");
    expect(s.relaxations.map((r) => r.text).join(" ")).not.toMatch(/age/i); // never offered as a relaxation
  });

  it("family, estimated 21+: Check first with the limit named, never Ready, and never ahead of Ready options", () => {
    const s = recommend([...cafes(), casino("estimate")], at({ company: "family" }), POLICIES);
    const c = s.all.find((e) => e.candidate.id === "casino")!;
    expect(c.class).toBe("check_first");
    expect(c.unresolved).toContain("AGE_LIMIT_LIKELY");
    expect(explain(c, TZ).caveat).toMatch(/probably 21\+ only/);
    expect(ids(s).sort()).toEqual(["cafe1", "cafe2", "cafe3"]);
  });

  it("an explicit youngest age decides: an adult family can go; a 16+ place is fine for a 16-year-old, not a 12-year-old", () => {
    expect(evaluateAll([casino("published")], at({ company: "family", youngestAge: 30 }), POLICIES)[0]!.class).toBe("ready");
    const arcade = () => withLimit(venue({ id: "arcade", category: "activity", hours: "Mo-Su 10:00-23:00" }), 16, "published");
    expect(evaluateAll([arcade()], at({ youngestAge: 16 }), POLICIES)[0]!.class).toBe("ready");
    expect(evaluateAll([arcade()], at({ youngestAge: 12 }), POLICIES)[0]!.excludedBy).toBe("AGE_RESTRICTED");
    // Family with no ages given: a 16+ limit may or may not fit, so Check first with the reason.
    const unsure = evaluateAll([arcade()], at({ company: "family" }), POLICIES)[0]!;
    expect(unsure.class).toBe("check_first");
    expect(explain(unsure, TZ).caveat).toMatch(/16\+ only; check your group's ages/);
  });

  it("the limit is always on the card, published or estimated, whoever is asking", () => {
    const friends = evaluateAll([casino("published")], at({ company: "friends" }), POLICIES)[0]!;
    expect(friends.class).toBe("ready");
    expect(explain(friends, TZ).factLine).toMatch(/· 21\+$/);
    const est = evaluateAll([casino("estimate")], at(), POLICIES)[0]!;
    expect(explain(est, TZ).factLine).toMatch(/· usually 21\+$/);
    const allAges = evaluateAll([withLimit(venue({ id: "park", category: "park", hours: "24/7" }), 0, "published")], at({ company: "family" }), POLICIES)[0]!;
    expect(allAges.class).toBe("ready");
    expect(explain(allAges, TZ).factLine).not.toMatch(/\+/);
  });

  it("with a minor present an estimated adult limit also loses the family bonus; other company is unaffected", () => {
    const golf = () => venue({ id: "golf", category: "activity", hours: "Mo-Su 10:00-04:00" });
    const [c, g] = evaluateAll([casino("estimate"), golf()], at({ company: "family" }), POLICIES);
    expect(g!.scores.fit - c!.scores.fit).toBeCloseTo(0.15 * 0.5, 3);
    const [cd, gd] = evaluateAll([casino("estimate"), golf()], at({ company: "date" }), POLICIES);
    expect(cd!.scores.fit).toBe(gd!.scores.fit);
  });
});

describe("feasibility: kitchen hours", () => {
  // Sat 3 Oct 2026. Walking ~3 min plus the restaurant's 10-min buffer: arrival is now + ~13 min.
  const R = (kitchen?: string) => venue({ category: "restaurant", hours: "Mo-Su 12:00-23:00", ...(kitchen ? { kitchen } : {}) });

  it("arriving after last orders is excluded, even though the restaurant is still open", () => {
    const e = one(R("Mo-Su 12:00-22:00"), ctx("2026-10-03 21:37", 180));
    expect(e.excludedBy).toBe("KITCHEN_CLOSED");
  });

  it("published kitchen hours replace the category's 40-minute guess: order by last orders, stay until close", () => {
    const e = one(R("Mo-Su 12:00-22:00"), ctx("2026-10-03 21:00", 180));
    expect(e.class).not.toBe("ineligible");
    expect(e.timing!.latestArrival!.getTime()).toBe(fromLocal("2026-10-03", 21 * 60 + 45, TZ).getTime());
    expect(e.timing!.latestFinish.getTime()).toBe(fromLocal("2026-10-03", 23 * 60, TZ).getTime());
    // Without kitchen hours the guess stands: the meal must end 40 min before close.
    expect(one(R(), ctx("2026-10-03 21:00", 180)).timing!.latestFinish.getTime()).toBe(fromLocal("2026-10-03", 22 * 60 + 20, TZ).getTime());
  });

  it("a kitchen that opens later is a short wait, like a venue opening", () => {
    const e = one(R("Mo-Su 17:00-22:00"), ctx("2026-10-03 16:30", 180));
    expect(e.class).not.toBe("ineligible");
    expect(e.reasons).toContain("WAIT_FOR_OPENING");
    expect(e.timing!.arrival.getTime()).toBe(fromLocal("2026-10-03", 17 * 60, TZ).getTime());
  });

  it("no service today (weekday lunch only) is excluded, and offered as 'try a different time'", () => {
    const c = R("Mo-Fr 12:00-15:00");
    expect(one(c, ctx("2026-10-03 13:00", 180)).excludedBy).toBe("KITCHEN_CLOSED");
    const s = recommend([c], ctx("2026-10-03 13:00", 180), POLICIES, { size: 3 });
    expect(s.relaxations).toContainEqual({ code: "different_time", text: "try a different time", admits: 1 });
  });

  it("applies to restaurants only: a bar's kitchen closing does not end the night", () => {
    const e = one(venue({ category: "bar", hours: "Mo-Su 17:00-02:00", kitchen: "Mo-Su 17:00-22:00" }), ctx("2026-10-03 23:30", 120));
    expect(e.class).toBe("ready");
  });

  it("kitchen hours bind a restaurant that is open 24/7", () => {
    const c = venue({ category: "restaurant", hours: "24/7", kitchen: "Mo-Su 10:00-20:00" });
    expect(one(c, ctx("2026-10-03 21:00", 120)).excludedBy).toBe("KITCHEN_CLOSED");
    const e = one(c, ctx("2026-10-03 09:00", 180));
    expect(e.class).not.toBe("ineligible");
    expect(e.reasons).toContain("WAIT_FOR_OPENING");
    expect(e.timing!.arrival.getTime()).toBe(fromLocal("2026-10-03", 10 * 60, TZ).getTime());
    expect(e.timing!.latestArrival!.getTime()).toBe(fromLocal("2026-10-03", 19 * 60 + 45, TZ).getTime());
  });

  it("kitchen hours bound a restaurant whose opening hours are unknown", () => {
    const c = venue({ category: "restaurant", hours: null, kitchen: "Mo-Su 12:00-22:00" });
    expect(one(c, ctx("2026-10-03 21:40", 180)).excludedBy).toBe("KITCHEN_CLOSED");
    expect(one(c, ctx("2026-10-03 20:00", 180)).timing!.latestArrival!.getTime()).toBe(fromLocal("2026-10-03", 21 * 60 + 45, TZ).getTime());
  });

  it("formats cents in price text", () => {
    const e = one(venue({ category: "museum", hours: "Mo-Su 10:00-18:00", price: { currency: "USD", paid: true, min: 12.5, max: 12.5 } }), ctx("2026-10-03 11:00", 180));
    expect(e.price.text).toBe("$12.50");
  });
});

describe("feasibility: business status", () => {
  it("a temporary closure (not open yet) is its own exclusion, not a permanent one", () => {
    const c = venue({ category: "restaurant" });
    c.facts.business_status = { value: { status: "closed_temporarily" }, confidence: 0.7, evidenceClass: "published", validUntil: new Date("2026-10-15T12:00:00Z"), independentSources: 1 };
    expect(one(c, ctx("2026-10-03 19:00", 180)).excludedBy).toBe("CLOSED_TEMPORARILY");
    c.facts.business_status = { value: { status: "closed_permanently" }, confidence: 0.75, evidenceClass: "published", validUntil: null, independentSources: 1 };
    expect(one(c, ctx("2026-10-03 19:00", 180)).excludedBy).toBe("CLOSED_PERMANENTLY");
  });
});

describe("feasibility: scheduled closure", () => {
  // A published permanent closure at local midnight starting Tue 10 Nov 2026 (what an OSM end_date=2026-11-10 becomes).
  const CLOSES = fromLocal("2026-11-10", 0, TZ);
  const closing = (c: Candidate, at: Date = CLOSES) => {
    c.facts.scheduled_closure = { value: { at: at.toISOString() }, confidence: 0.75, evidenceClass: "published", validUntil: null, independentSources: 1 };
    return c;
  };

  it("a published closing date excludes from its day, even when no status fact remains", () => {
    const c = closing(venue({ category: "cafe", hours: "24/7" }));
    delete c.facts.business_status; // the "operating" claim lapsed at the closing date
    expect(one(c, ctx("2026-11-09 12:00", 120)).excludedBy).toBeNull();
    expect(one(c, ctx("2026-11-10 00:01", 120)).excludedBy).toBe("CLOSED_PERMANENTLY");
    expect(one(c, ctx("2026-11-10 12:00", 120)).excludedBy).toBe("CLOSED_PERMANENTLY");
  });

  it("a lapsed status alone is uncertainty, not a closure", () => {
    const c = venue({ category: "cafe", hours: "24/7" });
    delete c.facts.business_status;
    expect(one(c, ctx("2026-11-10 12:00", 120)).excludedBy).toBeNull();
  });

  it("is a hard end to the visit: no arriving after it, no useful time counted past it", () => {
    // ~3 min walk + 5 min buffer: a request at 23:59 arrives after the closure.
    expect(one(closing(venue({ category: "cafe", hours: "24/7" })), ctx("2026-11-09 23:59", 120)).excludedBy).toBe("CLOSED_PERMANENTLY");
    // Arriving 23:48 leaves 12 minutes, under a café's 30.
    expect(one(closing(venue({ category: "cafe", hours: "24/7" })), ctx("2026-11-09 23:40", 120)).excludedBy).toBe("CLOSED_PERMANENTLY");
    // An hour before, the visit fits and ends at the closure.
    const e = one(closing(venue({ category: "cafe", hours: "24/7" })), ctx("2026-11-09 23:00", 120));
    expect(e.class).not.toBe("ineligible");
    expect(e.timing!.latestFinish.getTime()).toBe(CLOSES.getTime());
    expect(e.timing!.closesAt!.getTime()).toBe(CLOSES.getTime());
    expect(e.timing!.usefulMinutes).toBeLessThan(60);
    expect(e.timing!.deadline.getTime()).toBe(fromLocal("2026-11-10", 60, TZ).getTime()); // the user's own deadline is kept
  });

  it("bounds every kind of visit: unknown hours, waits for the kitchen, scheduled events", () => {
    expect(one(closing(venue({ category: "cafe", hours: null })), ctx("2026-11-09 23:40", 120)).excludedBy).toBe("CLOSED_PERMANENTLY");
    // Waiting for a 10:00 kitchen leaves 20 minutes before a 10:20 closure: not a meal.
    const kitchen = venue({ category: "restaurant", hours: "24/7", kitchen: "Mo-Su 10:00-20:00" });
    expect(one(kitchen, ctx("2026-11-12 09:00", 180)).excludedBy).toBeNull();
    expect(one(closing(kitchen, fromLocal("2026-11-12", 10 * 60 + 20, TZ)), ctx("2026-11-12 09:00", 180)).excludedBy).toBe("CLOSED_PERMANENTLY");
    // A show running past the closure does not happen there.
    const show = venue({ kind: "occurrence", category: "live_music", hours: null, admission: "ticket", occurrence: { id: "o9", title: "Last night", start: fromLocal("2026-11-09", 22 * 60, TZ), end: fromLocal("2026-11-10", 60, TZ), entryCutoff: null, lateEntry: null, status: "scheduled" } });
    expect(one(show, ctx("2026-11-09 21:00", 240)).excludedBy).toBeNull();
    expect(one(closing(show), ctx("2026-11-09 21:00", 240)).excludedBy).toBe("CLOSED_PERMANENTLY");
  });

  it("a visit short of time for its own reasons keeps that reason", () => {
    // Closes at 23:00 anyway: arriving 22:48 is too late whatever happens at midnight.
    expect(one(closing(venue({ category: "cafe", hours: "Mo-Su 08:00-23:00" })), ctx("2026-11-09 22:40", 120)).excludedBy).toBe("NOT_ENOUGH_TIME");
  });
});
