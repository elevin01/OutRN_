import { describe, expect, it } from "vitest";
import { areas, errors, ops, places, scenarios } from "./fixtures.js";
import { ApiError, AreasResponse, ERROR_CODES, OpsRunDetail, OpsRunList, PageRequest, PlaceDetails, RecommendationRequest, RecommendationResponse, ROUTES } from "./index.js";

/**
 * The fixtures are the UI's development data: they must be valid, linked, and cover every state a
 * screen has to handle, so the UI can be built and tested without a backend.
 */

const pages = scenarios.flatMap((s) => s.pages);
const items = pages.flatMap((p) => p.items);

describe("fixtures match the contract", () => {
  it("areas", () => {
    expect(AreasResponse.safeParse(areas).error).toBeUndefined();
  });

  it.each(scenarios.flatMap((s) => s.pages.map((p, i) => [`${s.id} page ${i + 1}`, p] as const)))("recommendations: %s", (_, page) => {
    expect(RecommendationResponse.safeParse(page).error).toBeUndefined();
  });

  it.each(Object.entries(places))("place %s", (_, place) => {
    expect(PlaceDetails.safeParse(place).error).toBeUndefined();
  });

  it("ops", () => {
    expect(OpsRunDetail.safeParse(ops.evaluate).error).toBeUndefined();
    expect(OpsRunList.safeParse(ops.runs).error).toBeUndefined();
  });

  it.each(Object.entries(errors))("error %s", (_, e) => {
    expect(ApiError.safeParse(e.body).error).toBeUndefined();
    expect(e.status).toBe(ERROR_CODES[e.body.error.code as keyof typeof ERROR_CODES]);
  });

  it("each scenario's request is a valid request", () => {
    for (const s of scenarios) expect(RecommendationRequest.safeParse(s.request).error, s.id).toBeUndefined();
  });
});

describe("fixtures are consistent", () => {
  it("pages chain by cursor, offsets advance by the page size, and only page 1 can be insufficient", () => {
    for (const s of scenarios) {
      s.pages.forEach((p, i) => {
        expect(p.page.offset, `${s.id} ${i}`).toBe(i * p.page.size);
        expect(p.items.length).toBeLessThanOrEqual(p.page.size);
        expect(p.requestId).toBe(s.pages[0]!.requestId);
        if (i > 0) expect(p.insufficient).toBeNull();
        if (i === 0) expect(p.page.prevCursor).toBeNull();
        if (i < s.pages.length - 1) expect(p.page.nextCursor).toBeTruthy();
      });
      expect(s.pages.at(-1)?.page.nextCursor ?? null, `${s.id}: the last captured page must end the chain`).toBe(s.expiresAfterFirstPage ? s.pages.at(-1)!.page.nextCursor : null);
    }
  });

  it("every item's place has a details fixture, and item ids are unique within a search", () => {
    for (const i of items) expect(places[i.placeId], i.name).toBeDefined();
    for (const s of scenarios) {
      const ids = s.pages.flatMap((p) => p.items.map((i) => i.id));
      expect(new Set(ids).size, s.id).toBe(ids.length);
    }
  });

  it("scenario areas are listed and page areas match their scenario", () => {
    for (const s of scenarios) for (const p of s.pages) expect(p.area.id).toBe(s.area.id);
  });
});

describe("fixtures cover every state a screen must handle", () => {
  const placeList = Object.values(places);
  const facts = placeList.flatMap((p) => p.facts);
  it.each([
    ["a Ready item", () => items.some((i) => i.status === "ready")],
    ["a Check first item with a required caveat", () => items.some((i) => i.status === "check_first" && i.caveats.some((c) => c.required))],
    ["a scheduled event", () => items.some((i) => i.kind === "event" && i.event !== null)],
    ["hours confirmed by a check", () => items.some((i) => i.reasons.some((r) => r.code === "HOURS_CONFIRMED"))],
    ["an estimated age limit", () => items.some((i) => i.ageLimit?.evidence === "estimate")],
    ["a drive with parking", () => items.some((i) => i.timing.travel.parkingMinutes !== null)],
    ["a drive that parks in a named lot, and one in an unnamed one", () => items.some((i) => i.parking?.name && i.plan.some((s) => s.kind === "park")) && items.some((i) => i.parking && i.parking.name === null)],
    ["a drive with no public parking nearby", () => items.some((i) => i.timing.travel.mode === "drive" && i.parking === null)],
    ["a usual crowd with an expected wait", () => items.some((i) => i.conditions.some((c) => c.kind === "crowd" && c.basis === "typical") && i.conditions.some((c) => c.kind === "wait" && c.minutes !== null))],
    ["a recent report of the crowd and the line", () => items.some((i) => i.conditions.some((c) => c.kind === "crowd" && c.basis === "report" && c.reportedAt !== null) && i.conditions.some((c) => c.kind === "wait" && c.basis === "report"))],
    ["a known price and an unknown one", () => items.some((i) => i.price.kind === "paid" && i.price.minCents !== null) && items.some((i) => i.price.kind === "unknown")],
    ["fewer than three, with relaxations", () => pages.some((p) => p.insufficient && p.insufficient.found > 0 && p.insufficient.relaxations.length > 0)],
    ["nothing fits", () => pages.some((p) => p.insufficient?.found === 0 && p.items.length === 0)],
    ["several pages", () => scenarios.some((s) => s.pages.length >= 3)],
    ["a stale check, due for recheck", () => facts.some((f) => f.provenance.dueForRecheck)],
    ["sources that disagree", () => facts.some((f) => f.provenance.conflict)],
    ["hours not listed", () => facts.some((f) => f.attribute === "opening_hours" && f.provenance.evidence === "missing")],
    ["a card with the place's own photos, credited, and one without", () => items.some((i) => i.photos.length > 1 && i.photos.every((p) => p.credit.includes("via Wikimedia Commons"))) && items.some((i) => i.photos.length === 0)],
    ["place details with photos", () => placeList.some((p) => p.photos.length > 0)],
    ["a place with parking nearby, and one without", () => placeList.some((p) => p.parkingNearby !== null) && placeList.some((p) => p.parkingNearby === null)],
    ["a place open now and one closed now", () => placeList.some((p) => p.hoursNow.state === "open") && placeList.some((p) => p.hoursNow.state === "closed")],
    ["an expired search with a restart", () => errors["cursor-expired"]?.body.error.restart !== undefined],
    ["an outage", () => errors["unavailable"]?.status === 503 && errors["unavailable"].body.error.retryable],
    ["a validation error with fields", () => (errors["validation"]?.body.error.fields?.length ?? 0) > 0],
    ["a missing place", () => errors["not-found"]?.status === 404],
  ])("%s", (_, covered) => {
    expect(covered()).toBe(true);
  });
});

describe("requests", () => {
  it("reject unknown fields, so a typo cannot silently drop a filter", () => {
    expect(RecommendationRequest.safeParse({ areaId: "les", windowMinutes: 120, budgett: { kind: "free" } }).success).toBe(false);
    expect(PageRequest.safeParse({ cursor: "x", areaId: "les" }).success).toBe(false);
  });

  it("take only item ids (UUIDs) in seen and dismissed lists, at most 200 each", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(RecommendationRequest.safeParse({ areaId: "les", windowMinutes: 120, seenIds: [id], dismissedIds: [id] }).success).toBe(true);
    expect(RecommendationRequest.safeParse({ areaId: "les", windowMinutes: 120, seenIds: ["x".repeat(10_000)] }).success).toBe(false);
    expect(RecommendationRequest.safeParse({ areaId: "les", windowMinutes: 120, dismissedIds: ["abc"] }).success).toBe(false);
    expect(RecommendationRequest.safeParse({ areaId: "les", windowMinutes: 120, seenIds: Array.from({ length: 201 }, () => id) }).success).toBe(false);
  });

  it("bound the window and the age", () => {
    expect(RecommendationRequest.safeParse({ areaId: "les", windowMinutes: 29 }).success).toBe(false);
    expect(RecommendationRequest.safeParse({ areaId: "les", windowMinutes: 481 }).success).toBe(false);
    expect(RecommendationRequest.safeParse({ areaId: "les", windowMinutes: 120, youngestAge: -1 }).success).toBe(false);
    expect(RecommendationRequest.safeParse({ areaId: "les", windowMinutes: 120, at: "tomorrow" }).success).toBe(false);
    expect(RecommendationRequest.safeParse({ areaId: "les", windowMinutes: 120, at: "2026-10-03T22:30:00Z" }).success).toBe(true);
  });

  it("every route names a response schema", () => {
    for (const r of Object.values(ROUTES)) expect(r.response).toBeDefined();
  });
});

describe("responses tolerate additions", () => {
  it("an unknown field or a new reason code parses (the backend may add both without a contract bump)", () => {
    const page = structuredClone(scenarios[0]!.pages[0]!) as RecommendationResponse & { future?: unknown };
    page.future = { anything: true };
    page.items[0]!.reasons.push({ code: "SOME_NEW_REASON", text: "something new", required: false, params: {} });
    page.items[0]!.category = { id: "axe_throwing", label: "Axe throwing" };
    expect(RecommendationResponse.safeParse(page).success).toBe(true);
  });
});
