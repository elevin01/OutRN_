import { describe, expect, it } from "vitest";
import { cuisineGroups, cuisineSlugs, MAX_CUISINES } from "./cuisine.js";
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
});
