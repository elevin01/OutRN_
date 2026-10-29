import { describe, expect, it } from "vitest";
import { parseSeatGeekPage, parseTicketingCapture, parseTicketmasterPage, seatGeekEvent, ticketmasterEvent } from "./ticketing.js";

/** Replies in the shape each API documents (Discovery API v2 events search; SeatGeek /2/events). */

const tm = (over: Record<string, unknown> = {}) => ({
  id: "vvG1zZ9KbXk4ab",
  name: "Mitski",
  url: "https://www.ticketmaster.com/mitski-new-york-new-york-10-30-2026/event/3B00609",
  dates: { start: { localDate: "2026-10-30", localTime: "20:00:00", dateTime: "2026-10-31T00:00:00Z", dateTBD: false, dateTBA: false, timeTBA: false, noSpecificTime: false }, timezone: "America/New_York", status: { code: "onsale" } },
  classifications: [{ primary: true, segment: { id: "KZFzniwnSyZfZ7v7nJ", name: "Music" }, genre: { name: "Rock" }, subGenre: { name: "Indie Rock" } }],
  priceRanges: [{ type: "standard", currency: "USD", min: 45, max: 89.5 }],
  _embedded: { venues: [{ id: "KovZpZAEdntA", name: "Bowery Ballroom", address: { line1: "6 Delancey St" }, city: { name: "New York" }, location: { longitude: "-73.99356", latitude: "40.72041" } }] },
  ...over,
});

describe("Ticketmaster events", () => {
  it("reads an event: its time, venue, kinds and price as given", () => {
    expect(ticketmasterEvent(tm())).toEqual({
      id: "vvG1zZ9KbXk4ab",
      title: "Mitski",
      url: "https://www.ticketmaster.com/mitski-new-york-new-york-10-30-2026/event/3B00609",
      start: "2026-10-31T00:00:00.000Z",
      status: "scheduled",
      venue: { name: "Bowery Ballroom", address: "6 Delancey St", lat: 40.72041, lon: -73.99356 },
      kinds: ["music", "rock", "indie rock"],
      price: { min: 45, max: 89.5 },
      adultsOnly: false,
      popularity: null,
    });
  });

  it("leaves out an event with no time yet, no place, a parking pass or a test event; reads cancellation and adults-only", () => {
    expect(ticketmasterEvent(tm({ dates: { start: { localDate: "2026-11-02", dateTBA: false, timeTBA: true } } }))).toEqual({ skip: "no_time" });
    expect(ticketmasterEvent(tm({ dates: { start: { dateTime: "2026-10-31T00:00:00Z", noSpecificTime: true } } }))).toEqual({ skip: "no_time" });
    expect(ticketmasterEvent(tm({ _embedded: { venues: [{ name: "Online" }] } }))).toEqual({ skip: "no_place" });
    expect(ticketmasterEvent(tm({ name: "PARKING: Knicks vs Celtics" }))).toEqual({ skip: "not_an_event" });
    expect(ticketmasterEvent(tm({ name: "Mitski - VIP Package" }))).toEqual({ skip: "not_an_event" });
    expect(ticketmasterEvent(tm({ test: true }))).toEqual({ skip: "not_an_event" });
    expect(ticketmasterEvent({ id: "x" })).toEqual({ skip: "unreadable" });
    expect(ticketmasterEvent(tm({ dates: { start: { dateTime: "2026-10-31T00:00:00Z" }, status: { code: "cancelled" } } }))).toMatchObject({ status: "cancelled" });
    expect(ticketmasterEvent(tm({ ageRestrictions: { legalAgeEnforced: true } }))).toMatchObject({ adultsOnly: true });
    // A price in another currency is not ours to convert; none at all is unknown.
    expect(ticketmasterEvent(tm({ priceRanges: [{ type: "standard", currency: "CAD", min: 60, max: 90 }] }))).toMatchObject({ price: null });
    expect(ticketmasterEvent(tm({ priceRanges: undefined }))).toMatchObject({ price: null });
  });

  it("reads a page and how many pages there are", () => {
    const page = parseTicketmasterPage({ _embedded: { events: [tm(), tm({ id: "b", name: "PARKING: Mitski" }), { nope: 1 }] }, page: { size: 200, totalElements: 3, totalPages: 1, number: 0 } });
    expect(page.events.map((e) => e.id)).toEqual(["vvG1zZ9KbXk4ab"]);
    expect(page.skipped).toEqual({ not_an_event: 1, unreadable: 1 });
    expect(page.totalPages).toBe(1);
    // No events at all: no _embedded.
    expect(parseTicketmasterPage({ page: { size: 200, totalElements: 0, totalPages: 0, number: 0 } }).events).toEqual([]);
  });
});

const sg = (over: Record<string, unknown> = {}) => ({
  id: 6123456,
  title: "John Mulaney",
  short_title: "John Mulaney",
  url: "https://seatgeek.com/john-mulaney-tickets/comedy/2026-10-30-7-pm/6123456",
  datetime_local: "2026-10-30T19:00:00",
  datetime_utc: "2026-10-30T23:00:00",
  datetime_tbd: false,
  time_tbd: false,
  date_tbd: false,
  type: "comedy",
  taxonomies: [{ id: 2000000, name: "comedy" }],
  score: 0.82,
  stats: { listing_count: 140, lowest_price: 79, highest_price: 410, average_price: 160 },
  venue: { id: 1, name: "Beacon Theatre", address: "2124 Broadway", city: "New York", location: { lat: 40.7805, lon: -73.9812 }, timezone: "America/New_York" },
  ...over,
});

describe("SeatGeek events", () => {
  it("reads an event: UTC time without its Z, kinds from type and taxonomies, resale price range, score", () => {
    expect(seatGeekEvent(sg())).toEqual({
      id: "6123456",
      title: "John Mulaney",
      url: "https://seatgeek.com/john-mulaney-tickets/comedy/2026-10-30-7-pm/6123456",
      start: "2026-10-30T23:00:00.000Z",
      status: "scheduled",
      venue: { name: "Beacon Theatre", address: "2124 Broadway", lat: 40.7805, lon: -73.9812 },
      kinds: ["comedy"],
      price: { min: 79, max: 410 },
      adultsOnly: false,
      popularity: 0.82,
    });
  });

  it("leaves out a time to be announced or a place it can't put on a map; a score outside 0–1 is no score", () => {
    expect(seatGeekEvent(sg({ time_tbd: true }))).toEqual({ skip: "no_time" });
    expect(seatGeekEvent(sg({ venue: { name: "TBA" } }))).toEqual({ skip: "no_place" });
    expect(seatGeekEvent(sg({ score: 7 }))).toMatchObject({ popularity: null });
    expect(seatGeekEvent(sg({ stats: { lowest_price: null } }))).toMatchObject({ price: null });
    expect(seatGeekEvent(sg({ type: "broadway_tickets_national", taxonomies: [{ name: "theater" }] }))).toMatchObject({ kinds: ["broadway tickets national", "theater"] });
  });

  it("reads a page and its total", () => {
    const page = parseSeatGeekPage({ events: [sg(), sg({ id: 2, title: "Parking Pass - Beacon Theatre" })], meta: { total: 2, page: 1, per_page: 100 } });
    expect(page.events).toHaveLength(1);
    expect(page.total).toBe(2);
  });
});

describe("a ticketed events capture", () => {
  it("is the events as read, never a key; anything else is refused", () => {
    const e = ticketmasterEvent(tm());
    const c = { outrn_capture: "ticketed-events", source: "ticketmaster", fetchedAt: "2026-10-29T16:00:00.000Z", area: "les", complete: true, events: [e] };
    expect(parseTicketingCapture(c, "t.json").events).toHaveLength(1);
    expect(() => parseTicketingCapture({ ...c, source: "stubhub" }, "t.json")).toThrow(/not a ticketed events capture/);
  });
});
