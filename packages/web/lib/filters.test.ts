import { describe, expect, it } from "vitest";
import type { ResolvedRequest } from "@outrn/contracts";
import { areas } from "@outrn/contracts/fixtures";
import { cardTags } from "./card";
import { FORM_TASTE_WEIGHT, formFromResolved, hrefForRequest, requestFromQuery } from "./request";

describe("cuisine, diets and must-haves on the web", () => {
  it("read from the form: one cuisine from the select, ticked boxes repeated or comma-joined", () => {
    const r = requestFromQuery({ area: "les", cuisine: "thai", diets: ["vegan", "gluten_free"], features: "outdoor_seating,wifi" }, areas);
    expect([r.cuisines, r.diets, r.features]).toEqual([["thai"], ["vegan", "gluten_free"], ["outdoor_seating", "wifi"]]);
    // Nothing asked for: nothing sent.
    const plain = requestFromQuery({ area: "les" }, areas);
    expect([plain.cuisines, plain.diets, plain.features]).toEqual([undefined, undefined, undefined]);
  });

  it("drop ids the area doesn't offer (prototype keys included), repeats, and anything past the limits", () => {
    const r = requestFromQuery({ area: "les", cuisines: "thai,__proto__,thai,sushi,ramen,pizza,korean,indian", diets: "vegan,constructor,paleo", features: ["wifi", "wifi", "jukebox"] }, areas);
    expect(r.cuisines).toEqual(["thai", "sushi", "ramen", "pizza", "korean"].slice(0, areas.limits.maxCuisines));
    expect(r.diets).toEqual(["vegan"]);
    expect(r.features).toEqual(["wifi"]);
  });

  it("round-trip through a link and back into the form", () => {
    const request = { areaId: "les", windowMinutes: 120, cuisines: ["thai", "vietnamese"], diets: ["vegan", "halal"], features: ["wheelchair"] };
    const query = Object.fromEntries(new URL(hrefForRequest(request, areas), "https://x.example").searchParams);
    expect(query).toMatchObject({ cuisines: "thai,vietnamese", diets: "vegan,halal", features: "wheelchair" });
    expect(requestFromQuery(query, areas)).toMatchObject({ cuisines: ["thai", "vietnamese"], diets: ["vegan", "halal"], features: ["wheelchair"] });
    // One cuisine travels as the form's select.
    expect(Object.fromEntries(new URL(hrefForRequest({ ...request, cuisines: ["thai"] }, areas), "https://x.example").searchParams)["cuisine"]).toBe("thai");
    const resolved: ResolvedRequest = { areaId: "les", windowMinutes: 120, travelMode: "walk", travelModeIsDefault: true, budget: { kind: "any" }, mood: null, company: null, youngestAge: null, categories: [], cuisines: ["thai"], diets: ["vegan", "halal"], features: ["wifi"], at: "2026-10-03T22:30:00.000Z", atIsExplicit: false, origin: { lat: 40.7185, lon: -73.988 }, originIsDefault: true, backBy: null, visitStyle: "dine_in", taste: [] };
    expect(formFromResolved(resolved, areas)).toMatchObject({ cuisine: "thai", diets: "vegan,halal", features: "wifi" });
  });

  it("send what you like (and what isn't for you) as a taste, offered interests only, a like winning", () => {
    const r = requestFromQuery({ area: "les", likes: ["art", "live_music", "__proto__", "art"], skips: "drinks,art,teleportation" }, areas);
    expect(r.taste).toEqual([
      { interest: "art", weight: FORM_TASTE_WEIGHT },
      { interest: "live_music", weight: FORM_TASTE_WEIGHT },
      { interest: "drinks", weight: -FORM_TASTE_WEIGHT },
    ]);
    expect(requestFromQuery({ area: "les" }, areas).taste).toBeUndefined();
    // Through a link and back into the form.
    const query = Object.fromEntries(new URL(hrefForRequest({ areaId: "les", windowMinutes: 120, taste: r.taste }, areas), "https://x.example").searchParams);
    expect(query).toMatchObject({ likes: "art,live_music", skips: "drinks" });
    expect(requestFromQuery(query, areas).taste).toEqual(r.taste);
    const resolved = { areaId: "les", windowMinutes: 120, travelMode: "walk", travelModeIsDefault: true, budget: { kind: "any" }, mood: null, company: null, youngestAge: null, categories: [], cuisines: [], diets: [], features: [], taste: r.taste!, at: "2026-10-03T22:30:00.000Z", atIsExplicit: false, origin: { lat: 40.7185, lon: -73.988 }, originIsDefault: true, backBy: null, visitStyle: "dine_in" } satisfies ResolvedRequest;
    expect(formFromResolved(resolved, areas)).toMatchObject({ likes: "art,live_music", skips: "drinks" });
  });

  it("the card lists what the place offers: its other cuisines, then diets and must-haves, each once", () => {
    const item = {
      copy: { summary: "Italian · ~5 min walk · takes about 1h20", sentence: null, caveat: null, action: "Go now" },
      cuisines: [{ id: "italian", label: "Italian" }, { id: "pizza", label: "Pizza" }],
      diets: [{ id: "vegetarian", label: "Vegetarian options" }, { id: "vegan", label: "Vegan options" }],
      features: [{ id: "outdoor_seating", label: "Outdoor seating" }, { id: "wifi", label: "Wi-Fi" }, { id: "wheelchair", label: "Wheelchair accessible" }],
    };
    expect(cardTags(item)).toEqual(["Pizza", "Vegetarian options", "Vegan options", "Outdoor seating", "Wi-Fi"]);
    expect(cardTags({ ...item, cuisines: [], diets: [], features: [] })).toEqual([]);
  });
});
