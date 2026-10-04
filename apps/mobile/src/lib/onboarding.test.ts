import { describe, expect, it } from "vitest";
import { areas } from "@outrn/contracts/fixtures";
import { RecommendationRequest } from "@outrn/contracts";
import {
  EMPTY_SETUP,
  EMPTY_TASTE,
  initialQuery,
  interestChoices,
  isPicked,
  nearestArea,
  parseSetup,
  parseTaste,
  readStored,
  requestTaste,
  toggleChoice,
} from "./onboarding";

describe("first-run preferences", () => {
  it("recovers missing, corrupt, and future profiles without keeping coordinates", () => {
    expect(readStored("{broken", parseSetup)).toEqual(EMPTY_SETUP);
    expect(parseSetup({ version: 2, completed: true })).toEqual(EMPTY_SETUP);
    expect(
      parseSetup({
        version: 1,
        completed: true,
        step: "area",
        areaId: "les",
        originSource: "device",
        origin: { lat: 1, lon: 2 },
      }),
    ).toEqual({
      version: 1,
      completed: true,
      step: "area",
      areaId: "les",
      originSource: "device",
      travelMode: undefined,
    });
    expect(parseSetup({ version: 1, completed: true }).completed).toBe(false);
  });
  it("accepts the existing taste storage shape and strips unsafe values", () => {
    const taste = parseTaste(
      JSON.parse(
        '{"asked":true,"weights":{"__proto__":1,"constructor":0.4,"food":20,"cafes":"1","outdoors":-2}}',
      ),
    );
    expect(taste.asked).toBe(true);
    expect(Object.hasOwn(taste.weights, "__proto__")).toBe(false);
    expect(taste.weights.food).toBe(1);
    expect(taste.weights.outdoors).toBe(-1);
    expect(Object.hasOwn(taste.weights, "cafes")).toBe(false);
    expect(Object.getPrototypeOf(taste.weights)).toBeNull();
  });
  it("makes binary picks, preserves unrelated tastes, and never turns deselection into a dislike", () => {
    const [food] = interestChoices(areas.filters.interests);
    const original = parseTaste({ asked: true, weights: { drinks: -0.8 } });
    const picked = toggleChoice(original, food!);
    expect(isPicked(picked, food!)).toBe(true);
    expect(picked.weights.food).toBe(0.8);
    expect(picked.weights.drinks).toBe(-0.8);
    expect(toggleChoice(picked, food!).weights).toEqual(original.weights);
  });
  it("only presents offered ids and keeps new interests editable", () => {
    const offered = [
      { id: "food", label: "Restaurants" },
      { id: "future_kind", label: "Something new" },
    ];
    expect(interestChoices(offered).map((choice) => choice.id)).toEqual([
      "food",
    ]);
    expect(
      interestChoices(offered, true).map((choice) => choice.label),
    ).toEqual(["Food spots", "Something new"]);
    const art = interestChoices([{ id: "art", label: "Art" }])[0]!;
    expect(art.interests).toEqual(["art"]);
  });
  it("caps offered weights at the server limit and leaves a skipped taste neutral", () => {
    expect(requestTaste(EMPTY_TASTE, areas)).toEqual([]);
    const taste = parseTaste({
      weights: { food: 0.8, cafes: 0.8, unknown: 1 },
    });
    expect(
      requestTaste(taste, {
        ...areas,
        limits: { ...areas.limits, maxTaste: 1 },
      }),
    ).toHaveLength(1);
    expect(requestTaste(taste, areas).map((item) => item.interest)).toEqual([
      "cafes",
      "food",
    ]);
  });
  it("builds a valid request from advertised defaults and makes a manual origin explicit by omission", () => {
    const setup = {
      ...EMPTY_SETUP,
      areaId: areas.defaultAreaId,
      travelMode: "transit" as const,
    };
    const manual = initialQuery(areas, setup)!;
    expect(RecommendationRequest.safeParse(manual).success).toBe(true);
    expect(manual).not.toHaveProperty("origin");
    expect(manual).not.toHaveProperty("categories");
    expect(
      initialQuery(areas, { ...setup, areaId: "removed" }),
    ).toBeUndefined();
    expect(
      initialQuery(areas, setup, { lat: 40.72, lon: -73.99 })?.origin,
    ).toEqual({ lat: 40.72, lon: -73.99 });
  });
  it("suggests the nearest center without inventing a coverage boundary", () => {
    for (const area of areas.areas)
      expect(nearestArea(areas.areas, area.center)?.id).toBe(area.id);
    expect(nearestArea([], { lat: 0, lon: 0 })).toBeUndefined();
  });
});
