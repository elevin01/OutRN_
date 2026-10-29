import { describe, expect, it, vi } from "vitest";

/** A read is the area's whole listing only when every page came back and every record on them was read. */

const pages = vi.hoisted(() => ({ next: [] as unknown[] }));
vi.mock("./fetch.js", async (orig) => ({ ...(await orig<typeof import("./fetch.js")>()), guardedFetch: async () => ({ text: JSON.stringify(pages.next.shift()) }) }));

const { fetchTicketedEvents } = await import("./ticketing.js");

const q = { center: { lat: 40.7185, lon: -73.988 }, radiusM: 3000, from: new Date("2026-10-29T16:00:00Z"), until: new Date("2026-11-12T16:00:00Z"), key: "k" };
const tm = { id: "a", name: "Mitski", dates: { start: { dateTime: "2026-10-31T00:00:00Z" } }, _embedded: { venues: [{ name: "Bowery Ballroom", location: { latitude: "40.72041", longitude: "-73.99356" } }] } };
const sg = { id: 1, title: "John Mulaney", datetime_utc: "2026-10-31T00:00:00", venue: { name: "Beacon Theatre", location: { lat: 40.7805, lon: -73.9812 } } };

describe("a ticketing read's completeness", () => {
  it("an empty answer is the whole listing; one with a record it could not read is not", async () => {
    pages.next = [{ page: { number: 0, totalPages: 0 } }];
    expect((await fetchTicketedEvents("ticketmaster", q)).complete).toBe(true);
    pages.next = [{ _embedded: { events: [{ id: "broken" }] }, page: { number: 0, totalPages: 1 } }];
    expect(await fetchTicketedEvents("ticketmaster", q)).toMatchObject({ events: [], skipped: { unreadable: 1 }, complete: false });
    pages.next = [{ _embedded: { events: [tm, { id: "broken" }] }, page: { number: 0, totalPages: 1 } }];
    expect(await fetchTicketedEvents("ticketmaster", q)).toMatchObject({ skipped: { unreadable: 1 }, complete: false });
    pages.next = [{ _embedded: { events: [tm] }, page: { number: 0, totalPages: 1 } }];
    expect((await fetchTicketedEvents("ticketmaster", q)).complete).toBe(true);

    pages.next = [{ events: [], meta: { total: 0 } }];
    expect((await fetchTicketedEvents("seatgeek", q)).complete).toBe(true);
    pages.next = [{ events: [{ id: 123 }], meta: { total: 1 } }];
    expect(await fetchTicketedEvents("seatgeek", q)).toMatchObject({ events: [], skipped: { unreadable: 1 }, complete: false });
    pages.next = [{ events: [sg], meta: { total: 1 } }];
    expect((await fetchTicketedEvents("seatgeek", q)).complete).toBe(true);
    // A parking pass left out is no gap in the listing: it was read, and is not an event.
    pages.next = [{ _embedded: { events: [tm, { ...tm, id: "p", name: "PARKING: Mitski" }] }, page: { number: 0, totalPages: 1 } }];
    expect(await fetchTicketedEvents("ticketmaster", q)).toMatchObject({ skipped: { not_an_event: 1 }, complete: true });
  });
});
