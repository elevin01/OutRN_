import { describe, expect, it } from "vitest";
import type { NycParksEventRow } from "@outrn/sources";
import { decodeEntities, nycParksEvents } from "./nyc-parks.js";

const LES = { center: { lat: 40.7185, lon: -73.988 }, radiusM: 3100, timezone: "America/New_York" };
const NOW = new Date("2026-10-24T12:00:00Z");

let n = 0;
function row(over: Partial<NycParksEventRow> = {}): NycParksEventRow {
  return {
    guid: over.guid ?? String(2_200_000 + ++n),
    title: "Harvest Festival",
    link: { url: "http://www.nycgovparks.org/events/2026/10/24/harvest-festival" },
    description: "Join us for a free afternoon of music, crafts and cider.",
    starttime: "2026-10-24T14:00:00.000",
    endtime: "2026-10-24T18:00:00.000",
    location: "Seward Park",
    coordinates: "40.71445, -73.98935",
    categories: "Festivals | Fall Festivals | Best for Kids | Food",
    registration_description: "Registration not required.",
    ...over,
  };
}
const one = (over: Partial<NycParksEventRow> = {}) => nycParksEvents([row(over)], LES, NOW).events[0];

describe("NYC Parks events as an area's events", () => {
  it("reads a listing as it says it: local times, its page over https, categories as interests, walk-in and free", () => {
    expect(one()).toEqual({
      id: expect.any(String),
      title: "Harvest Festival",
      start: "2026-10-24T18:00:00.000Z",
      end: "2026-10-24T22:00:00.000Z",
      url: "https://www.nycgovparks.org/events/2026/10/24/harvest-festival",
      kinds: ["festivals", "food"],
      forKids: true,
      admission: "walk_in",
      price: { free: true },
      place: { name: "Seward Park", lat: 40.71445, lon: -73.98935 },
    });
  });

  it("registers first when the listing says so; full when registration has closed; cancelled when the title says so", () => {
    expect(one({ registration_description: "Registration has begun and ends on 10/24/2026.", registration_url: { url: "https://nycparks.perfectmind.com/x" } })?.admission).toBe("reservation");
    expect(one({ registration_description: undefined, registration_url: { url: "https://www.eventbrite.com/e/1" } })?.admission).toBe("reservation");
    expect(one({ registration_description: "Registration is closed." })).toMatchObject({ status: "sold_out" });
    expect(one({ title: "CANCELED: Zumba" })).toMatchObject({ status: "cancelled" });
    // Saying nothing about it says nothing: admission stays unknown.
    expect(one({ registration_description: undefined })).not.toHaveProperty("admission");
  });

  it("is free only when the listing says so and names no price", () => {
    expect(one({ description: "Tickets: $30.00; free for members." })).not.toHaveProperty("price");
    expect(one({ description: "A tour of the old house." })).not.toHaveProperty("price");
  });

  it("decodes the table's entities, and keeps to the area, the future and outings", () => {
    expect(decodeEntities("NYC Parks&#8217; 44th Annual Wreath&nbsp;Open Call")).toBe("NYC Parks’ 44th Annual Wreath Open Call");
    expect(decodeEntities("P&#233;tanque &amp; Bocce &#x26; more &bogus; &#1;x")).toBe("Pétanque & Bocce & more &bogus; x");
    const { events, skipped } = nycParksEvents(
      [
        row({ guid: "far", coordinates: "40.8594, -73.9341" }),
        row({ guid: "online", categories: "Virtual/Online Events | Talks" }),
        row({ guid: "untimed", starttime: undefined }),
        row({ guid: "nowhere", coordinates: undefined }),
        row({ guid: "over", starttime: "2026-10-23T10:00:00.000", endtime: "2026-10-23T11:00:00.000" }),
        row({ guid: "kept" }),
      ],
      LES,
      NOW,
    );
    expect(events.map((e) => e.id)).toEqual(["kept"]);
    expect(skipped).toEqual({ far: 1, no_time: 1, no_place: 1, online: 1, over: 1 });
  });

  it("takes the first of several points, runs an evening past midnight, and reads times across the clock change", () => {
    expect(one({ coordinates: "40.7200, -73.9900; 40.7300, -73.9800" })?.place).toMatchObject({ lat: 40.72, lon: -73.99 });
    expect(one({ starttime: "2026-10-24T22:00:00.000", endtime: "2026-10-24T01:00:00.000" })).toMatchObject({ start: "2026-10-25T02:00:00.000Z", end: "2026-10-25T05:00:00.000Z" });
    // Sunday 1 November: 10am is EST (UTC-5), the day after EDT ends.
    expect(one({ starttime: "2026-11-01T10:00:00.000", endtime: "2026-11-01T11:00:00.000" })).toMatchObject({ start: "2026-11-01T15:00:00.000Z" });
  });
});
