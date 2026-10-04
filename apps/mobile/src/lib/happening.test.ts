import { describe, expect, it } from "vitest";
import { scenarios } from "@outrn/contracts/fixtures";
import type { RecommendationItem, RecommendationResponse } from "@outrn/contracts";
import { happeningSoon, SOON_MINUTES } from "./happening";

const events = scenarios.find((s) => s.id === "events")!.pages[0]!;
const asOf = Date.parse(events.asOf);
const show = events.items.find((i) => i.kind === "event")!;

const withItems = (items: RecommendationItem[]): RecommendationResponse => ({ ...events, items });
const startingIn = (item: RecommendationItem, minutes: number, love = false): RecommendationItem => ({
  ...item,
  id: `${item.id}-${minutes}-${love}`,
  event: { ...item.event!, startsAt: new Date(asOf + minutes * 60_000).toISOString() },
  reasons: love ? [{ code: "TASTE_MATCH", text: "matches your taste for theatre & dance", required: false, params: { interest: "theatre" } }, ...item.reasons] : item.reasons,
});

describe("happening soon", () => {
  it("nudges an event starting within two hours, never a place", () => {
    expect(happeningSoon(events, asOf)?.name).toBe("The Tenement Follies");
    expect(happeningSoon(withItems(events.items.filter((i) => i.kind === "venue")), asOf)).toBeNull();
    expect(happeningSoon(withItems([startingIn(show, SOON_MINUTES + 30)]), asOf)).toBeNull();
    expect(happeningSoon(undefined, asOf)).toBeNull();
  });

  it("prefers one this person loves over the engine's first", () => {
    const first = startingIn(show, 20);
    const loved = startingIn(show, 90, true);
    expect(happeningSoon(withItems([first, loved]), asOf)?.id).toBe(loved.id);
    expect(happeningSoon(withItems([first, startingIn(show, 90)]), asOf)?.id).toBe(first.id);
  });

  it("keeps one on now that the engine still offers (a walk-in pop-up joined late)", () => {
    expect(happeningSoon(withItems([startingIn(show, -20)]), asOf)).not.toBeNull();
  });
});
