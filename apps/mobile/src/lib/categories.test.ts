import { describe, expect, it } from "vitest";
import { activeGroup, categoryIcon, CATEGORY_GROUPS, groupsFor } from "./categories";

const ALL = ["restaurant", "cafe", "bar", "dessert", "museum", "gallery", "theatre", "cinema", "live_music", "arts_centre", "market", "park", "garden", "waterfront", "viewpoint", "attraction", "library", "bookshop", "bowling", "arcade", "nightclub", "activity"].map((id) => ({ id }));

describe("category shortcuts", () => {
  it("fit the API's limit of five kinds each, and every kind has an icon", () => {
    for (const g of CATEGORY_GROUPS) expect(g.categories.length, g.id).toBeLessThanOrEqual(5);
    for (const { id } of ALL) expect(categoryIcon(id), id).not.toBe("map-marker-outline");
    expect(categoryIcon("something-new")).toBe("map-marker-outline");
    expect(categoryIcon("__proto__")).toBe("map-marker-outline");
    // A pop-up's own site is a "Happening".
    expect(categoryIcon("event_site")).toBe("calendar-star");
  });

  it("show only what the area offers, and hide a shortcut with nothing in it", () => {
    const groups = groupsFor([{ id: "restaurant" }, { id: "park" }, { id: "cinema" }], 5);
    expect(groups.map((g) => g.id)).toEqual(["all", "food", "outdoors", "shows"]);
    expect(groups.find((g) => g.id === "food")!.categories).toEqual(["restaurant"]);
    expect(groupsFor(ALL, 2).find((g) => g.id === "culture")!.categories).toHaveLength(2);
  });

  it("know which shortcut a search is on: all without categories, none for a custom mix", () => {
    const groups = groupsFor(ALL, 5);
    expect(activeGroup(groups, undefined)).toBe("all");
    expect(activeGroup(groups, [])).toBe("all");
    expect(activeGroup(groups, ["live_music", "cinema", "theatre"])).toBe("shows");
    expect(activeGroup(groups, ["cafe"])).toBeNull();
  });
});
