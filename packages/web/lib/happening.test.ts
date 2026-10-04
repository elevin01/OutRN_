import { describe, expect, it } from "vitest";
import type { RecommendationItem, RecommendationResponse } from "@outrn/contracts";
import { scenarios } from "@outrn/contracts/fixtures";
import { eventsOnlyOf, happeningSoon, SOON_MINUTES } from "./happening";

const events = scenarios.find((s) => s.id === "events")!.pages[0]!;
const asOf = Date.parse(events.asOf);
const show = events.items.find((i) => i.kind === "event")!;
const at = (minutes: number, love = false): RecommendationItem => ({
  ...show,
  id: `${minutes}-${love}`,
  event: { ...show.event!, startsAt: new Date(asOf + minutes * 60_000).toISOString() },
  reasons: love ? [{ code: "TASTE_MATCH", text: "matches your taste", required: false, params: {} }, ...show.reasons] : show.reasons,
});
const page = (items: RecommendationItem[]): RecommendationResponse => ({ ...events, items });

describe("happening soon on the web", () => {
  it("asks the same search for events only, without narrowing to a kind of place", () => {
    expect(eventsOnlyOf({ areaId: "les", windowMinutes: 120, categories: ["restaurant"], cuisines: ["thai"], diets: ["vegan"], features: ["wifi"], visitStyle: "takeout", company: "family", taste: [{ interest: "art", weight: 1 }] })).toEqual({
      areaId: "les",
      windowMinutes: 120,
      company: "family",
      taste: [{ interest: "art", weight: 1 }],
      eventsOnly: true,
    });
  });

  it("lists events starting within two hours, loves first, never a place", () => {
    expect(happeningSoon(events, asOf).map((i) => i.name)).toEqual(["The Tenement Follies"]);
    expect(happeningSoon(page([at(20), at(90, true), at(SOON_MINUTES + 30)]), asOf).map((i) => i.id)).toEqual(["90-true", "20-false"]);
    expect(happeningSoon(null, asOf)).toEqual([]);
  });
});
