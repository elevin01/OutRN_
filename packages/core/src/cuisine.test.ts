import { describe, expect, it } from "vitest";
import { CUISINE_FILTERS, cuisineFromName, cuisineGroups, cuisineLabel, cuisineMatches, cuisineSlugs, MAX_CUISINES } from "./cuisine.js";
import { validateFactValue } from "./fact-values.js";

describe("cuisine", () => {
  it("reads OSM cuisine lists as slugs, in the mapper's order, once each", () => {
    expect(cuisineSlugs("italian;pizza")).toEqual(["italian", "pizza"]);
    expect(cuisineSlugs(" Italian ; Pizza, Tex-Mex;coffee shop ")).toEqual(["italian", "pizza", "tex_mex", "coffee_shop"]);
    expect(cuisineSlugs("thai;Thai;THAI")).toEqual(["thai"]);
  });

  it("drops what isn't a cuisine name, and keeps at most eight", () => {
    expect(cuisineSlugs("")).toEqual([]);
    expect(cuisineSlugs(undefined)).toEqual([]);
    expect(cuisineSlugs(";;x;<script>;café;" + "a".repeat(41))).toEqual([]);
    const many = Array.from({ length: 12 }, (_, i) => `c${i}x`).join(";");
    expect(cuisineSlugs(many)).toHaveLength(MAX_CUISINES);
  });

  it("groups the cuisines a diner would call the same kind of food", () => {
    expect(cuisineGroups(["italian", "pizza"])).toEqual(new Set(["italian"]));
    expect(cuisineGroups(["sushi"])).toEqual(cuisineGroups(["ramen"]));
    expect(cuisineGroups(["cafe"])).toEqual(cuisineGroups(["coffee_shop"]));
    // Unlisted cuisines are their own group, and a filipino place is not a thai one.
    expect(cuisineGroups(["filipino"])).toEqual(new Set(["filipino"]));
    expect([...cuisineGroups(["filipino"])].some((g) => cuisineGroups(["thai"]).has(g))).toBe(false);
    // A slug that is an Object.prototype key is just a slug.
    expect(cuisineGroups(["constructor", "__proto__"])).toEqual(new Set(["constructor", "__proto__"]));
  });

  it("the stored fact is a short list of distinct slugs", () => {
    expect(validateFactValue("cuisine", { values: ["italian", "pizza"] })).toBeNull();
    expect(validateFactValue("cuisine", { values: [] })).not.toBeNull();
    expect(validateFactValue("cuisine", { values: ["italian", "italian"] })).not.toBeNull();
    expect(validateFactValue("cuisine", { values: ["Italian"] })).not.toBeNull();
    expect(validateFactValue("cuisine", { values: Array.from({ length: 9 }, (_, i) => `c${i}x`) })).not.toBeNull();
    expect(validateFactValue("cuisine", { value: "italian" })).not.toBeNull();
  });

  it("a search's cuisine takes in its kinds; a kind is only itself", () => {
    expect(cuisineMatches(["japanese"], ["sushi"])).toBe(true);
    expect(cuisineMatches(["japanese"], ["asian", "ramen"])).toBe(true);
    expect(cuisineMatches(["sushi"], ["ramen"])).toBe(false);
    expect(cuisineMatches(["pizza"], ["italian_pizza"])).toBe(true);
    expect(cuisineMatches(["italian"], ["pizza"])).toBe(true);
    expect(cuisineMatches(["pizza"], ["italian"])).toBe(false);
    expect(cuisineMatches(["thai", "korean"], ["korean_bbq"])).toBe(true);
    // Nothing known, or an id that is not a filter's own, matches nothing.
    expect(cuisineMatches(["thai"], [])).toBe(false);
    for (const id of ["__proto__", "constructor", "toString", "sushi_bar"]) expect(cuisineMatches([id], ["sushi", "constructor"])).toBe(false);
  });

  it("every filter lists valid slugs, its own id among them, and a label", () => {
    for (const [id, f] of Object.entries(CUISINE_FILTERS)) {
      expect(f.members).toContain(id);
      expect(f.label.length).toBeGreaterThan(2);
      expect(new Set(f.members).size).toBe(f.members.length);
      for (const m of f.members) expect(validateFactValue("cuisine", { values: [m] })).toBeNull();
    }
  });

  it("labels a cuisine as a card shows it", () => {
    expect(cuisineLabel("thai")).toBe("Thai");
    expect(cuisineLabel("bubble_tea")).toBe("Bubble tea");
    expect(cuisineLabel("tex_mex")).toBe("Tex-Mex");
    expect(cuisineLabel("middle_eastern")).toBe("Middle Eastern");
    expect(cuisineLabel("coffee_shop")).toBe("Coffee");
    expect(cuisineLabel("constructor")).toBe("Constructor");
  });

  it("reads what a name says a place serves: whole words, cuisine words only", () => {
    expect(cuisineFromName("Arturo's Coal Oven Pizza")).toEqual(["pizza"]);
    expect(cuisineFromName("Taqueria Diana")).toEqual(["mexican"]);
    expect(cuisineFromName("Los Tacos No. 1")).toEqual(["mexican"]);
    expect(cuisineFromName("Great Szechuan")).toEqual(["sichuan"]);
    expect(cuisineFromName("Joe's Shanghai")).toEqual(["chinese"]);
    expect(cuisineFromName("Phở Bằng")).toEqual(["vietnamese"]);
    expect(cuisineFromName("Katz's Delicatessen")).toEqual(["deli"]);
    expect(cuisineFromName("Superiority Burger")).toEqual(["burger"]);
    expect(cuisineFromName("Caracas Arepa Bar")).toEqual(["venezuelan"]);
    expect(cuisineFromName("Ethiopian Kitchen")).toEqual(["ethiopian"]);
    expect(cuisineFromName("Sushi & Ramen House")).toEqual(["sushi", "ramen"]);
    // Words a rule used are not read again: Korean BBQ is one cuisine, not three.
    expect(cuisineFromName("Kang Ho Dong Korean BBQ")).toEqual(["korean_bbq"]);
    expect(cuisineFromName("Dim Sum Go Go")).toEqual(["dim_sum"]);
    // Italian ice is a dessert, not an Italian meal.
    expect(cuisineFromName("Ralph's Famous Italian Ices and Ice Cream")).toEqual(["italian_ice"]);
    expect(cuisineMatches(["italian"], cuisineFromName("Ralph's Famous Italian Ices"))).toBe(false);
    // Words that are not cuisines, or only part of one, say nothing.
    for (const name of ["The Dinner Party", "Delicious Kitchen", "Photo Booth Bar", "Fish Cheeks", "Grand Kitchen", "Pizzazz Lounge", "The Standard", ""]) expect(cuisineFromName(name)).toEqual([]);
  });
});
