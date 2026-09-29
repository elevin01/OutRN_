import { describe, expect, it } from "vitest";
import { dietLabel, dietsFromName, dietsFromTags, hasDietTags, servesDiet } from "./diets.js";
import { validateFactValue } from "./fact-values.js";

describe("diets", () => {
  it("reads OSM diet:* tags as levels, with the tags it read; anything else is dropped", () => {
    expect(dietsFromTags({ "diet:vegan": "only", "diet:vegetarian": "Yes", "diet:halal": "limited" })).toEqual({ levels: { vegan: "only", vegetarian: "yes", halal: "limited" }, evidence: "diet:vegetarian=yes; diet:vegan=only; diet:halal=limited" });
    expect(dietsFromTags({ "diet:vegan": "sometimes", "diet:paleo": "yes", "diet:__proto__": "yes" })).toBeNull();
    expect(dietsFromTags({})).toBeNull();
    // Tags we can't read are still tags: the mapper said something, so a name doesn't stand in for them.
    expect([hasDietTags({ "diet:vegan": "unknown" }), hasDietTags({ "diet:paleo": "yes" }), hasDietTags({ cuisine: "vegan" }), hasDietTags({})]).toEqual([true, true, false, false]);
  });

  it("reads what a name says: a vegetarian or kosher place is all that; halal is on offer", () => {
    expect(dietsFromName("Jisu Vegetarian")).toEqual({ vegetarian: "only" });
    expect(dietsFromName("East Side Glatt")).toEqual({ kosher: "only" });
    expect(dietsFromName("Madina Halal Deli")).toEqual({ halal: "yes" });
    expect(dietsFromName("Bodhi Kosher Vegetarian Restaurant")).toEqual({ vegetarian: "only", kosher: "only" });
    for (const name of ["Vegetables & Co", "Halalbros", "The Standard", ""]) expect(dietsFromName(name)).toEqual({});
    // "Kosher-style" is a kind of deli food, not a kosher kitchen.
    for (const name of ["Katz's Kosher-Style Deli", "Kosher Style Pickles"]) expect(dietsFromName(name), name).toEqual({});
    expect(dietsFromName("Glatt Kosher Grill")).toEqual({ kosher: "only" });
  });

  it("serves a diet at yes or only; vegan food is vegetarian food; anything else is no", () => {
    expect(servesDiet({ vegan: "only" }, "vegan")).toBe(true);
    expect(servesDiet({ vegan: "yes" }, "vegetarian")).toBe(true);
    expect(servesDiet({ vegetarian: "only" }, "vegan")).toBe(false);
    expect(servesDiet({ gluten_free: "limited" }, "gluten_free")).toBe(false);
    expect(servesDiet({ halal: "no" }, "halal")).toBe(false);
    expect(servesDiet({}, "kosher")).toBe(false);
    for (const id of ["__proto__", "constructor", "toString", "paleo"]) expect(servesDiet({ vegan: "only" }, id)).toBe(false);
  });

  it("labels a diet as a card shows it", () => {
    expect(dietLabel("vegan", "only")).toBe("Vegan");
    expect(dietLabel("gluten_free", "yes")).toBe("Gluten-free options");
    expect(dietLabel("halal", "limited")).toBeNull();
    expect(dietLabel("kosher", undefined)).toBeNull();
  });

  it("the stored fact names known diets at known levels, at least one", () => {
    expect(validateFactValue("diets", { vegan: "only", halal: "yes" })).toBeNull();
    expect(validateFactValue("diets", {})).not.toBeNull();
    expect(validateFactValue("diets", { vegan: "sometimes" })).not.toBeNull();
    expect(validateFactValue("diets", { paleo: "yes" })).not.toBeNull();
    expect(validateFactValue("internet_access", { value: "wlan" })).toBeNull();
    expect(validateFactValue("internet_access", { value: "wifi" })).not.toBeNull();
  });
});
