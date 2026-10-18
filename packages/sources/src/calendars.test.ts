import { describe, expect, it } from "vitest";
import { CALENDAR_MAX_PAGES, FeedInvalid, parseCalendarCapture, parseCivicPlusRss, parseICalendar, parseTecPage, readCalendar, type CalendarFeedRef, type CalendarReadOptions } from "./calendars.js";
import type { RobotsPolicy } from "./robots.js";

const TZ = "America/New_York";

/** Shaped like Springshare LibCal's feed: UTC times, folded lines, escaped commas, a category list. */
const LIBCAL = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Springshare//LibCal//EN",
  "X-WR-TIMEZONE:America/New_York",
  "BEGIN:VEVENT",
  "DTSTART:20261020T143000Z",
  "DTEND:20261020T150000Z",
  "SUMMARY:Baby Lap Time & Chat Time",
  "DESCRIPTION:Songs\\, rhymes and books for babies. Registration is required. ",
  " Space is limited.",
  "LOCATION:Children's Program Room",
  "ORGANIZER;CN=\"Synthetic Librarian\":MAILTO:someone@example.org",
  "CATEGORIES:Storytime, Crafts",
  "UID:LibCal-1-1001",
  "URL:https://synthetic.libcal.com/event/1001",
  "BEGIN:VALARM",
  "DESCRIPTION:Not the event",
  "TRIGGER:-PT15M",
  "END:VALARM",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART;VALUE=DATE:20261031",
  "SUMMARY:Library Closed",
  "CATEGORIES:Closings",
  "UID:LibCal-1-1002",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/New_York:20261024T103000",
  "DURATION:PT1H30M",
  "SUMMARY:Howloween in the Park",
  "LOCATION:Pine Ridge Park\\, 1 Example Rd\\, Rye Brook\\, NY",
  "STATUS:CANCELLED",
  "RRULE:FREQ=WEEKLY;COUNT=3",
  "UID:2388@example.gov",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART;TZID=Eastern Standard Time:20261025T190000",
  "SUMMARY:Floating zone",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

describe("iCalendar", () => {
  it("reads events: UTC, a TZID's local time, a date for all day, a duration, folded and escaped text, nothing from an alarm", () => {
    const [baby, closed, howl, floating] = parseICalendar(LIBCAL, TZ);
    expect(baby).toMatchObject({
      uid: "LibCal-1-1001",
      title: "Baby Lap Time & Chat Time",
      start: "2026-10-20T14:30:00.000Z",
      end: "2026-10-20T15:00:00.000Z",
      allDay: false,
      location: ["Children's Program Room"],
      categories: ["Storytime", "Crafts"],
      url: "https://synthetic.libcal.com/event/1001",
      cancelled: false,
      recurring: false,
    });
    expect(baby!.text).toBe("Songs, rhymes and books for babies. Registration is required. Space is limited.");
    expect(closed).toMatchObject({ title: "Library Closed", allDay: true, start: "2026-10-31T04:00:00.000Z", end: null });
    // 10:30am in New York (EDT) is 14:30 UTC; 90 minutes on.
    expect(howl).toMatchObject({ start: "2026-10-24T14:30:00.000Z", end: "2026-10-24T16:00:00.000Z", cancelled: true, recurring: true });
    expect(howl!.location).toEqual(["Pine Ridge Park", "1 Example Rd", "Rye Brook", "NY"]);
    // A zone Intl doesn't know is read in the feed's.
    expect(floating!.start).toBe("2026-10-25T23:00:00.000Z");
  });

  it("skips an event without a summary or a start, and bare LF line endings work too", () => {
    const ics = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "SUMMARY:No start", "END:VEVENT", "BEGIN:VEVENT", "DTSTART:20261020T143000Z", "END:VEVENT", "BEGIN:VEVENT", "DTSTART:20261020T143000Z", "SUMMARY:Ok", "END:VEVENT", "END:VCALENDAR"].join("\n");
    expect(parseICalendar(ics, TZ).map((e) => e.title)).toEqual(["Ok"]);
  });
});

describe("The Events Calendar (WordPress)", () => {
  it("reads a page: UTC times, entities in titles, the venue's lines, categories, cost, and the next page", () => {
    const page = {
      events: [
        {
          id: 10017164,
          title: "Stay &amp; Play with Paper Mache",
          url: "https://parks.example.gov/event/stay-and-play/2026-10-20/",
          start_date: "2026-10-20 09:30:00",
          utc_start_date: "2026-10-20 13:30:00",
          utc_end_date: "2026-10-20 14:30:00",
          all_day: false,
          cost: "$5",
          categories: [{ name: "Arts, Culture &amp; History Programs" }],
          venue: { venue: "Lasdon Public Gardens", address: "2610 Example Road", city: "Katonah" },
          description: "<p>Free for members.</p><p>Ages 3 &amp; up</p>",
        },
        { id: 2, title: "No venue", utc_start_date: "2026-10-21 13:30:00", venue: [], categories: [] },
        { id: 3, title: "", utc_start_date: "2026-10-21 13:30:00" },
      ],
      next_rest_url: "https://parks.example.gov/wp-json/tribe/events/v1/events/?page=2",
    };
    const { events, next, truncated } = parseTecPage(page);
    expect(truncated).toBe(false);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ uid: "10017164", title: "Stay & Play with Paper Mache", start: "2026-10-20T13:30:00.000Z", end: "2026-10-20T14:30:00.000Z", location: ["Lasdon Public Gardens", "2610 Example Road", "Katonah"], categories: ["Arts, Culture & History Programs"], cost: "$5", text: "Free for members. Ages 3 & up" });
    expect(events[1]!.location).toEqual([]);
    expect(next).toBe("https://parks.example.gov/wp-json/tribe/events/v1/events/?page=2");
  });

  it("refuses what is not a page of events: no events list, or not one entry readable; an empty list is a page", () => {
    for (const body of [{}, [], null, "events", { events: "none" }, { events: [{ id: 1 }, { title: "No start" }] }]) expect(() => parseTecPage(body)).toThrow(FeedInvalid);
    expect(parseTecPage({ events: [] })).toEqual({ events: [], next: null, truncated: false });
  });
});

/** Shaped like a CivicPlus town calendar's RSS. */
const CIVICPLUS = `<?xml version="1.0"?><rss version="2.0" xmlns:calendarEvent="https://town.example.gov/Calendar.aspx"><channel>
<item>
  <title>Halloween Parade</title>
  <link>https://town.example.gov/Calendar.aspx?EID=4553</link>
  <pubDate>Tue, 29 Sep 2026 09:07:08 -0500</pubDate>
  <description>&lt;strong&gt;Event date:&lt;/strong&gt; October 18, 2026 &lt;br&gt;&lt;strong&gt;Event Time: &lt;/strong&gt;03:00 PM - 04:40 PM&lt;br&gt;&lt;strong&gt;Location:&lt;/strong&gt; &lt;br&gt;Harbor Island Park&lt;br&gt;Mamaroneck, NY 10543</description>
  <calendarEvent:EventDates> October 18, 2026 </calendarEvent:EventDates>
  <calendarEvent:EventTimes>03:00 PM - 04:40 PM</calendarEvent:EventTimes>
  <calendarEvent:Location>Harbor Island ParkMamaroneck, NY 10543</calendarEvent:Location>
  <guid isPermaLink="false">https://town.example.gov/Calendar.aspx?EID=4553/639262696280000000</guid>
</item>
<item>
  <title>Fall Exhibit</title>
  <link>https://town.example.gov/Calendar.aspx?EID=12</link>
  <calendarEvent:EventDates> October 13, 2026 - October 30, 2026 </calendarEvent:EventDates>
  <calendarEvent:EventTimes></calendarEvent:EventTimes>
  <calendarEvent:Location>Town Hall</calendarEvent:Location>
</item>
<item><title>No date</title><calendarEvent:EventDates>TBA</calendarEvent:EventDates></item>
</channel></rss>`;

describe("CivicPlus calendar RSS", () => {
  it("reads written dates and times in the town's zone, and the location's lines from the description", () => {
    const [parade, exhibit, ...rest] = parseCivicPlusRss(CIVICPLUS, TZ);
    expect(rest).toEqual([]);
    expect(parade).toMatchObject({ title: "Halloween Parade", start: "2026-10-18T19:00:00.000Z", end: "2026-10-18T20:40:00.000Z", allDay: false, location: ["Harbor Island Park", "Mamaroneck, NY 10543"], url: "https://town.example.gov/Calendar.aspx?EID=4553" });
    expect(parade!.uid).toBe("https://town.example.gov/Calendar.aspx?EID=4553/639262696280000000");
    // No time: all day, from the first date to the last.
    expect(exhibit).toMatchObject({ allDay: true, start: "2026-10-13T04:00:00.000Z", end: "2026-10-30T04:00:00.000Z", location: ["Town Hall"] });
  });
});

describe("reading a feed", () => {
  const open: RobotsPolicy = { status: "ok", rules: [], crawlDelayS: 20 };
  const tec: CalendarFeedRef = { id: "parks", url: "https://parks.example.gov/wp-json/tribe/events/v1/events", format: "tec" };
  const range = { timeZone: TZ, from: new Date("2026-10-18T00:00:00Z"), until: new Date("2026-11-17T00:00:00Z") };
  /** Answers like guardedFetch: the gate is asked first, and a refusal sends nothing. */
  const answers =
    (body: (url: URL) => string, asked: { url: string; minIntervalMs: number }[] = []): NonNullable<CalendarReadOptions["get"]> =>
    async (url, o) => {
      const pace = await o.gate(new URL(url));
      asked.push({ url, minIntervalMs: pace ? pace.minIntervalMs : -1 });
      return body(new URL(url));
    };
  const tecPage = (n: number, next: string | null) => JSON.stringify({ events: [{ id: n, title: `Event ${n}`, utc_start_date: "2026-10-20 13:30:00" }], next_rest_url: next });

  it("asks for the run's range, follows the pages on its own host, and keeps robots.txt's crawl delay", async () => {
    const asked: { url: string; minIntervalMs: number }[] = [];
    const pages: Record<string, unknown> = {
      1: { events: [{ id: 1, title: "One", utc_start_date: "2026-10-20 13:30:00" }], next_rest_url: "https://parks.example.gov/wp-json/tribe/events/v1/events?page=2" },
      2: { events: [{ id: 2, title: "Two", utc_start_date: "2026-10-21 13:30:00" }], next_rest_url: null },
    };
    const read = await readCalendar(tec, { ...range, robots: new Map(), robotsFor: async () => open, get: answers((u) => JSON.stringify(pages[u.searchParams.get("page") ?? "1"]), asked) });
    expect(read).toMatchObject({ status: "ok", pages: 2, complete: true });
    expect(read.events.map((e) => e.title)).toEqual(["One", "Two"]);
    expect(asked[0]!.url).toBe("https://parks.example.gov/wp-json/tribe/events/v1/events?per_page=50&start_date=2026-10-18&end_date=2026-11-17");
    expect(asked.map((a) => a.minIntervalMs)).toEqual([20_000, 20_000]);
  });

  it("is not the whole feed when a page is left unread: the page limit, a next page on another site, or one robots.txt keeps us from", async () => {
    const base = "https://parks.example.gov/wp-json/tribe/events/v1/events";
    const endless = await readCalendar(tec, { ...range, robots: new Map(), robotsFor: async () => open, get: answers((u) => tecPage(Number(u.searchParams.get("page") ?? 1), `${base}?page=${Number(u.searchParams.get("page") ?? 1) + 1}`)) });
    expect(endless).toMatchObject({ status: "ok", pages: CALENDAR_MAX_PAGES, complete: false, incomplete: `more than ${CALENDAR_MAX_PAGES} pages` });
    expect(endless.events).toHaveLength(CALENDAR_MAX_PAGES);

    const asked: { url: string; minIntervalMs: number }[] = [];
    const away = await readCalendar(tec, { ...range, robots: new Map(), robotsFor: async () => open, get: answers(() => tecPage(1, "https://elsewhere.example.com/wp-json/tribe/events/v1/events?page=2"), asked) });
    expect(away).toMatchObject({ status: "ok", pages: 1, complete: false, incomplete: "a next page on elsewhere.example.com" });
    expect(asked).toHaveLength(1);

    const noPage2: RobotsPolicy = { status: "ok", rules: [{ allow: false, path: "/*page=2" }], crawlDelayS: null };
    const blocked = await readCalendar(tec, { ...range, robots: new Map(), robotsFor: async () => noPage2, get: answers((u) => (u.searchParams.get("page") ? tecPage(2, null) : tecPage(1, `${base}?page=2`))) });
    expect(blocked).toMatchObject({ status: "ok", pages: 1, complete: false });
    expect(blocked.incomplete).toMatch(/robots\.txt disallows/);
    expect(blocked.events.map((e) => e.title)).toEqual(["Event 1"]);
  });

  it("is not the whole feed when it has more events than are kept", async () => {
    const many = JSON.stringify({ events: Array.from({ length: 2001 }, (_, i) => ({ id: i, title: `Event ${i}`, utc_start_date: "2026-10-20 13:30:00" })) });
    const read = await readCalendar(tec, { ...range, robots: new Map(), robotsFor: async () => open, get: answers(() => many) });
    expect(read).toMatchObject({ status: "ok", complete: false });
    expect(read.events).toHaveLength(2000);
  });

  it("fails, and is not the whole feed, when it answers with something that is not one: an empty calendar is", async () => {
    const ical: CalendarFeedRef = { id: "lib", url: "https://lib.example.org/ical", format: "ical" };
    const civic: CalendarFeedRef = { id: "town", url: "https://town.example.gov/RSSFeed.aspx?ModID=58&CID=All-calendar.xml", format: "civicplus" };
    const reading = (feed: CalendarFeedRef, body: string) => readCalendar(feed, { ...range, robots: new Map(), robotsFor: async () => open, get: answers(() => body) });
    for (const [feed, body] of [
      [tec, "{}"],
      [tec, "<html>Maintenance</html>"],
      [tec, JSON.stringify({ events: [{ id: 1 }] })],
      [ical, "Temporarily unavailable"],
      [ical, "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20261020T143000Z\r\nSUMMARY:Cut short"],
      [civic, "<error>Maintenance</error>"],
      [civic, '<?xml version="1.0"?><rss version="2.0"><channel><item><title>Cut short</title>'],
    ] as const)
      expect(await reading(feed, body), `${feed.format}: ${body.slice(0, 30)}`).toMatchObject({ status: "failed", complete: false, events: [] });
    for (const [feed, body] of [
      [tec, JSON.stringify({ events: [] })],
      [ical, "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n"],
      [civic, '<?xml version="1.0"?><rss version="2.0"><channel><title>Calendar</title></channel></rss>'],
    ] as const)
      expect(await reading(feed, body), `${feed.format}: empty`).toMatchObject({ status: "ok", complete: true, events: [] });
  });

  it("reads a saved read that does not say it is whole as not whole", () => {
    const capture = parseCalendarCapture({ outrn_capture: "calendars", fetchedAt: "2026-10-18T00:00:00Z", reads: [{ feed: "a", url: "https://a.example", status: "ok", pages: 1, events: [] }, { feed: "b", url: "https://b.example", status: "ok", pages: 1, events: [], complete: true }] }, "test");
    expect(capture.reads.map((r) => r.complete)).toEqual([false, true]);
  });

  it("reads nothing robots.txt keeps us from, and only the bare address where it forbids query strings", async () => {
    const asked: string[] = [];
    const get: NonNullable<CalendarReadOptions["get"]> = async (url, o) => {
      await o.gate(new URL(url));
      asked.push(url);
      return JSON.stringify({ events: [] });
    };
    const shut: RobotsPolicy = { status: "ok", rules: [{ allow: false, path: "/" }], crawlDelayS: null };
    expect(await readCalendar(tec, { ...range, robots: new Map(), robotsFor: async () => shut, get })).toMatchObject({ status: "robots", pages: 0 });
    const unreachable: RobotsPolicy = { status: "unreachable", rules: [], crawlDelayS: null };
    expect(await readCalendar(tec, { ...range, robots: new Map(), robotsFor: async () => unreachable, get })).toMatchObject({ status: "robots", error: "robots.txt could not be read" });
    expect(asked).toEqual([]);
    const noQueries: RobotsPolicy = { status: "ok", rules: [{ allow: false, path: "/*?" }], crawlDelayS: null };
    expect(await readCalendar(tec, { ...range, robots: new Map(), robotsFor: async () => noQueries, get })).toMatchObject({ status: "ok", pages: 1 });
    expect(asked).toEqual(["https://parks.example.gov/wp-json/tribe/events/v1/events"]);
  });

  it("reports a failed read without throwing", async () => {
    const read = await readCalendar({ id: "x", url: "https://lib.example.org/ical", format: "ical" }, { ...range, robots: new Map(), robotsFor: async () => open, get: async () => Promise.reject(new Error("503 from lib.example.org")) });
    expect(read).toMatchObject({ status: "failed", error: "503 from lib.example.org", events: [], complete: false });
  });
});
