import { describe, expect, it } from "vitest";
import { eventsFeedOf, extractFromJsonLd, extractJsonLdBlocks, extractPage, openingHoursFromSpec, schemaDate } from "./firstparty.js";

const html = `<html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Restaurant","name":"Example Kitchen","telephone":"+1 212 555 0199","priceRange":"$$",
 "acceptsReservations":"True",
 "openingHoursSpecification":[
   {"@type":"OpeningHoursSpecification","dayOfWeek":["Monday","Tuesday","Wednesday","Thursday"],"opens":"17:00","closes":"22:30"},
   {"@type":"OpeningHoursSpecification","dayOfWeek":"https://schema.org/Friday","opens":"17:00","closes":"00:30"},
   {"@type":"OpeningHoursSpecification","dayOfWeek":"Saturday","opens":"12:00","closes":"00:30","validFrom":"2026-12-01","validThrough":"2026-12-31"}
 ]}
</script>
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
 {"@type":"MusicEvent","name":"Late Set","startDate":"2026-10-03T20:00:00-04:00","endDate":"2026-10-03T22:00:00-04:00","eventStatus":"https://schema.org/EventScheduled",
  "offers":{"@type":"Offer","price":"15","priceCurrency":"USD","availability":"https://schema.org/InStock"},"url":"https://example.org/late-set"},
 {"@type":"Event","name":"Cancelled Thing","startDate":"2026-10-04T19:00:00-04:00","eventStatus":"https://schema.org/EventCancelled"},
 {"@type":"Event","name":"Sold Out Thing","startDate":"2026-10-05T19:00:00-04:00","offers":[{"@type":"Offer","price":"0","priceCurrency":"USD","availability":"https://schema.org/SoldOut"}]}
]}
</script>
<script type="application/ld+json">{ this is not json }</script>
</head><body>Hours: whenever</body></html>`;

describe("first-party JSON-LD extraction", () => {
  const blocks = extractJsonLdBlocks(html);
  const x = extractFromJsonLd(blocks, "https://example.org/", new Date("2026-09-26T12:00:00Z"));

  it("reads no opening hours from under a delivery or seasonal heading, with copy in between (PR #57 review)", () => {
    for (const heading of ["Delivery Hours", "Summer Hours"]) {
      const html = `<html><body><section><h2>${heading}</h2><p>See our schedule below</p><p>Mon-Sun 9am-9pm</p></section></body></html>`;
      expect(extractPage(html, "https://venue.example.com/", new Date("2026-10-18T12:00:00Z")).facts.filter((f) => f.attribute === "opening_hours"), heading).toEqual([]);
    }
  });

  it("reads what an event is from its schema.org type", () => {
    expect(x.events.map((e) => [e.title, e.kinds])).toEqual([
      ["Late Set", ["live_music"]],
      ["Cancelled Thing", []],
      ["Sold Out Thing", []],
    ]);
  });

  it("finds valid blocks and skips broken ones", () => {
    expect(blocks).toHaveLength(2);
    expect(x.types).toEqual(expect.arrayContaining(["Restaurant", "MusicEvent", "Event"]));
  });

  it("extracts business facts with the JSON as evidence", () => {
    expect(x.facts.find((f) => f.attribute === "name")).toMatchObject({ value: { value: "Example Kitchen" }, status: "stated" });
    expect(x.facts.find((f) => f.attribute === "phone")?.evidence).toContain("telephone");
    expect(x.facts.find((f) => f.attribute === "price")).toMatchObject({ value: { min: 15, max: 35, tier: 2 } });
    expect(x.facts.find((f) => f.attribute === "admission")).toMatchObject({ value: { requirement: "reservation_available" } });
  });

  it("converts openingHoursSpecification to weekly intervals, handles past-midnight closes, skips date-bounded exceptions", () => {
    const h = x.facts.find((f) => f.attribute === "opening_hours")!;
    const weekly = (h.value as { weekly: { weekday: number; startMin: number; endMin: number }[] }).weekly;
    expect(weekly.filter((w) => w.weekday >= 1 && w.weekday <= 4)).toHaveLength(4);
    const fri = weekly.find((w) => w.weekday === 5)!;
    expect(fri.endMin).toBe(24 * 60 + 30);
    expect(weekly.find((w) => w.weekday === 6)).toBeUndefined(); // validFrom/validThrough exception not merged into the weekly rule
  });

  it("extracts events with status, price and url; never invents an end time", () => {
    expect(x.events).toHaveLength(3);
    const late = x.events.find((e) => e.title === "Late Set")!;
    expect(late.status).toBe("scheduled");
    expect(late.price).toEqual({ min: 15, max: 15, currency: "USD" });
    expect(late.end).not.toBeNull();
    expect(x.events.find((e) => e.title === "Cancelled Thing")).toMatchObject({ status: "cancelled", end: null });
    expect(x.events.find((e) => e.title === "Sold Out Thing")).toMatchObject({ status: "sold_out", price: { free: true } });
  });

  it("openingHoursFromSpec returns null when nothing usable is present", () => {
    expect(openingHoursFromSpec([{ dayOfWeek: "Monday" }])).toBeNull();
  });
});

describe("JSON-LD block scan on hostile pages", () => {
  it("stays linear on crafted input at the 3 MB fetch cap", () => {
    const cap = 3 * 1024 * 1024;
    for (const unit of ["<script", '<script type="application/ld+json">', "<script type=", "<SCRIPT >x"]) {
      const page = unit.repeat(Math.floor(cap / unit.length));
      const t0 = Date.now();
      expect(extractJsonLdBlocks(page)).toEqual([]);
      expect(Date.now() - t0, unit).toBeLessThan(1500);
    }
  });

  it("reads blocks with mixed-case tags and other attributes, and not text inside another script", () => {
    const page = `<SCRIPT id="a" TYPE='application/ld+json' nonce="n">{"@type":"Bar","name":"A"}</SCRIPT>
      <script>var s = '<script type="application/ld+json">{"name":"inside a string"}</script>';</script>
      <script type="text/javascript">{"name":"not json-ld"}</script>
      <script type="application/ld+json">{"@type":"Bar","name":"B"}</script>`;
    expect(extractJsonLdBlocks(page)).toEqual([{ "@type": "Bar", name: "A" }, { "@type": "Bar", name: "B" }]);
  });
});

describe("JSON-LD days that name what every object inherits", () => {
  it("are not days of the week", () => {
    for (const day of ["__proto__", "constructor", "toString", "https://schema.org/constructor"]) {
      const x = extractFromJsonLd([{ "@type": "Restaurant", name: "R", openingHoursSpecification: [{ "@type": "OpeningHoursSpecification", dayOfWeek: day, opens: "10:00", closes: "12:00" }] }], "https://r.example/", new Date("2026-09-28T12:00:00Z"));
      const hours = x.facts.find((f) => f.attribute === "opening_hours");
      const weekly = (hours?.value as { weekly?: { weekday: unknown }[] } | undefined)?.weekly ?? [];
      expect(weekly.every((w) => typeof w.weekday === "number"), day).toBe(true);
      expect(weekly, day).toHaveLength(0);
    }
  });
});


describe("schema.org openingHours text", () => {
  it("is read as OSM's syntax: a separator between days, no spaces around the dash", async () => {
    const { osmHoursFromSchema } = await import("./firstparty.js");
    expect(osmHoursFromSchema("Su 09:00 - 23:00 Mo 09:00 - 23:00 Fr 09:00 - 00:00")).toBe("Su 09:00-23:00; Mo 09:00-23:00; Fr 09:00-00:00");
    expect(osmHoursFromSchema("Mo-Fr 11:00-22:00, Sa 12:00-23:00")).toBe("Mo-Fr 11:00-22:00, Sa 12:00-23:00");
  });
});

describe("a venue's own events: where its site lists them, and what each says", () => {
  const home = "https://www.theatre.example.org/";
  it("finds The Events Calendar's API, an iCalendar feed it links, or a page of its own for events, best first", () => {
    expect(eventsFeedOf(`<body class="tribe-events-page"><a href="/events/">Events</a></body>`, home)).toEqual({ format: "tec", url: "https://www.theatre.example.org/wp-json/tribe/events/v1/events" });
    expect(eventsFeedOf(`<link rel="alternate" type="text/calendar" title="iCal" href="https://theatre.example.org/?ical=1"><a href="/events">x</a>`, home)).toEqual({ format: "ical", url: "https://theatre.example.org/?ical=1" });
    expect(eventsFeedOf(`<a href="/about">About</a><a href="https://www.theatre.example.org/shows/#upcoming">Shows</a>`, home)).toEqual({ format: "page", url: "https://www.theatre.example.org/shows/" });
    expect(eventsFeedOf(`<a href="/en/calendar">Calendar</a>`, home)).toEqual({ format: "page", url: "https://www.theatre.example.org/en/calendar" });
    // Another site's listing, a private-events page, a link back home, or nothing: none.
    for (const html of [`<a href="https://www.ticketmaster.com/events">Tickets</a>`, `<link type="text/calendar" href="https://calendar.google.com/x.ics">`, `<a href="/private-events">Private events</a>`, `<a href="/">Home</a>`, `<p>Welcome</p>`]) expect(eventsFeedOf(html, home), html).toBeUndefined();
  });

  it("reads a page of crafted links in linear time", () => {
    const t0 = performance.now();
    expect(eventsFeedOf("<a ".repeat(200_000), home)).toBeUndefined();
    expect(eventsFeedOf(`<a href="${"x".repeat(400)}">`.repeat(5_000), home)).toBeUndefined();
    expect(eventsFeedOf("<link ".repeat(200_000), home)).toBeUndefined();
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("reads a date and time with no offset on the venue's clock, a date alone as the whole day", () => {
    const TZ = "America/New_York";
    expect(schemaDate("2026-10-24T19:30", TZ)).toEqual({ at: new Date("2026-10-24T23:30:00.000Z"), allDay: false });
    expect(schemaDate("2026-10-24T19:30:00", TZ)!.at.toISOString()).toBe("2026-10-24T23:30:00.000Z");
    expect(schemaDate("2026-10-24T19:30:00-04:00", TZ)!.at.toISOString()).toBe("2026-10-24T23:30:00.000Z");
    expect(schemaDate("2026-10-24T23:30:00Z", TZ)!.at.toISOString()).toBe("2026-10-24T23:30:00.000Z");
    // A day the month does not have is no date, not the 2nd of the next month.
    expect(schemaDate("2026-02-30T19:30", TZ)).toBeNull();
    expect(schemaDate("2026-04-31", TZ)).toBeNull();
    expect(schemaDate("2028-02-29T19:30", TZ)!.at.toISOString()).toBe("2028-03-01T00:30:00.000Z");
    expect(schemaDate("2026-10-24", TZ)).toEqual({ at: new Date("2026-10-24T04:00:00.000Z"), allDay: true });
    for (const v of ["soon", "2026-13-40T99:99", "", 42, null]) expect(schemaDate(v, TZ), String(v)).toBeNull();
  });

  it("keeps where an event says it is held, its types, and free only when it says so", () => {
    const x = extractFromJsonLd(
      [
        { "@context": "https://schema.org", "@type": "MusicEvent", name: "Jazz Trio", startDate: "2026-10-24T20:00", location: { "@type": "Place", name: "Garcia's", address: { "@type": "PostalAddress", streetAddress: "149 Westchester Ave", addressLocality: "Port Chester" } }, offers: { price: "0", priceCurrency: "USD" } },
        { "@type": ["TheaterEvent", "ChildrensEvent"], name: "Puppet Show", startDate: "2026-10-25", location: "Main Stage", isAccessibleForFree: true },
      ],
      "https://www.theatre.example.org/",
      new Date("2026-10-18T12:00:00Z"),
    );
    expect(x.events[0]).toMatchObject({ title: "Jazz Trio", start: new Date("2026-10-25T00:00:00.000Z"), allDay: false, types: ["MusicEvent"], location: ["Garcia's", "149 Westchester Ave", "Port Chester"], free: false });
    expect(x.events[1]).toMatchObject({ allDay: true, types: ["TheaterEvent", "ChildrensEvent"], location: ["Main Stage"], free: true });
  });
});
