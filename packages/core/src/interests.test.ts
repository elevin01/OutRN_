import { describe, expect, it } from "vitest";
import { CATEGORIES } from "./categories.js";
import { INTERESTS, interestsOf, interestsOfTitle, isDrinkTitle, isInterest } from "./interests.js";

describe("interests", () => {
  it("are the table's own keys only", () => {
    expect(isInterest("live_music")).toBe(true);
    for (const k of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", ""]) expect(isInterest(k), k).toBe(false);
  });

  it("map every category, and only onto interests", () => {
    for (const category of CATEGORIES) {
      for (const [k, v] of Object.entries(interestsOf({ category }))) {
        expect(isInterest(k), `${category} → ${k}`).toBe(true);
        expect(v).toBeGreaterThan(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
    expect(interestsOf({ category: "bar" })).toEqual({ drinks: 1, nightlife: 0.5 });
    expect(interestsOf({ category: "gallery" })).toEqual({ art: 1 });
  });

  it("read a subtype when it says more than the category, and never a prototype key", () => {
    expect(interestsOf({ category: "activity", subtype: "climbing" })).toEqual({ sports: 1 });
    expect(interestsOf({ category: "attraction", subtype: "zoo" })).toEqual({ outdoors: 1, museums: 0.5 });
    for (const subtype of ["constructor", "__proto__", "toString", "valueOf"]) expect(interestsOf({ category: "activity", subtype })).toEqual({ games: 1 });
  });

  it("read an event's title first, and the place it is held at for half", () => {
    expect(interestsOf({ category: "park", title: "Jazz on the Lawn" })).toEqual({ live_music: 1, outdoors: 0.5 });
    expect(interestsOf({ category: "bar", title: "Comedy Night" })).toEqual({ comedy: 1, drinks: 0.5, nightlife: 0.25 });
    expect(interestsOf({ category: "waterfront", title: "Fireworks over the river" })).toEqual({ festivals: 1, outdoors: 0.5 });
    // A title that says nothing is the place's outing.
    expect(interestsOf({ category: "museum", title: "The Tenement Follies" })).toEqual({ museums: 1, art: 0.5 });
  });

  it("match whole words only", () => {
    for (const title of ["Rockwood Sessions", "Detour", "Smart Talkers", "Affairs of State", "Bandwidth"]) {
      const got = interestsOfTitle(title);
      expect(got.live_music ?? 0, title).toBe(0);
      expect(got.museums ?? 0, title).toBe(0);
      expect(got.art ?? 0, title).toBe(0);
      expect(got.festivals ?? 0, title).toBe(0);
    }
    expect(interestsOfTitle("Stand-up at Eight")).toEqual({ comedy: 1 });
    expect(interestsOfTitle("Open mic")).toEqual({ comedy: 0.5, live_music: 0.5 });
  });

  it("read drink as the outing, and a food tasting as food", () => {
    for (const t of ["Wine Tasting", "Happy Hour", "Craft Brewery Night", "Beer Garden", "Pub Crawl", "Whiskey Flight", "Tasting Night"]) {
      expect(interestsOfTitle(t).drinks, t).toBe(1);
      expect(isDrinkTitle(t), t).toBe(true);
    }
    for (const t of ["Cheese Tasting", "Chocolate tasting", "Ice Cream Tasting", "Coffee Tasting", "Jazz Night", "Barbershop Quartet"]) {
      expect(interestsOfTitle(t).drinks ?? 0, t).toBe(0);
      expect(isDrinkTitle(t), t).toBe(false);
    }
    expect(interestsOfTitle("Cheese Tasting")).toEqual({ food: 1 });
    expect(interestsOfTitle("Coffee Tasting")).toEqual({ cafes: 1 });
  });

  it("read a runaway title quickly, and only its start", () => {
    const long = "a".repeat(100_000) + " jazz";
    const t0 = performance.now();
    expect(interestsOfTitle(long)).toEqual({});
    expect(interestsOfTitle(`jazz ${"-".repeat(100_000)}`)).toEqual({ live_music: 1 });
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it("have labels", () => {
    for (const [id, label] of Object.entries(INTERESTS)) expect(label.length, id).toBeGreaterThan(2);
  });
});
