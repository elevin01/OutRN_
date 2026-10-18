import { describe, expect, it } from "vitest";
import { hoursFromText, hoursLinks, microdataHours, visibleLines, visibleText } from "./sitehours.js";

const page = (body: string) => `<html><head><title>x</title><script>var hours = "Mon-Fri 1am-2am";</script><style>.mon{}</style></head><body>${body}</body></html>`;
const read = (body: string) => {
  const v = visibleText(page(body));
  return hoursFromText(v.lines, v);
};
const h = (hh: number, mm = 0) => hh * 60 + mm;

describe("visible text", () => {
  it("leaves out scripts, styles, comments and the head, breaks lines at blocks, and decodes entities", () => {
    expect(visibleLines(page(`<!-- Mon 9am-5pm --><p>Monday&nbsp;&ndash; Friday</p><div>11:00&#8239;AM &#8211; 10pm</div><span>a</span> <b>b</b>`))).toEqual(["Monday – Friday", "11:00 AM – 10pm", "a b"]);
  });

  it("is linear on a crafted page (a megabyte of unclosed tags)", () => {
    const t0 = performance.now();
    visibleLines("<script".repeat(50_000) + "<div".repeat(100_000));
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe("hours written out on a venue's own page", () => {
  it("reads day ranges, lists, lunch and dinner, a split statement and late closes", () => {
    const x = read(`<h3>Hours</h3><p>Monday - Thursday: 11:30am - 2:30pm, 5pm - 10pm</p><p>Fri &amp; Sat: 11:30 AM - 12:30 AM</p><p>Sunday</p><p>noon - 9pm</p>`);
    expect(x?.weekly).toEqual([
      { weekday: 0, startMin: h(12), endMin: h(21) },
      { weekday: 1, startMin: h(11, 30), endMin: h(14, 30) },
      { weekday: 1, startMin: h(17), endMin: h(22) },
      { weekday: 2, startMin: h(11, 30), endMin: h(14, 30) },
      { weekday: 2, startMin: h(17), endMin: h(22) },
      { weekday: 3, startMin: h(11, 30), endMin: h(14, 30) },
      { weekday: 3, startMin: h(17), endMin: h(22) },
      { weekday: 4, startMin: h(11, 30), endMin: h(14, 30) },
      { weekday: 4, startMin: h(17), endMin: h(22) },
      { weekday: 5, startMin: h(11, 30), endMin: h(24, 30) },
      { weekday: 6, startMin: h(11, 30), endMin: h(24, 30) },
    ]);
    expect(x?.evidence).toContain("Monday - Thursday: 11:30am - 2:30pm, 5pm - 10pm");
  });

  it("leaves a holiday's line out and reads the rest; a season elsewhere on the page doesn't matter", () => {
    const x = read(`<h3>Hours &amp; Holidays</h3><p>Mon-Sat 10am-9pm</p><p>Sunday 12pm-5pm</p><p>Christmas Eve: Sun 10am-2pm</p><p>Visit us</p><h4>Summer reading</h4><p>Join us!</p>`);
    expect(x?.weekly).toHaveLength(7);
    expect(x?.evidence).not.toContain("Christmas");
  });

  it("reads 'open daily', closed days, a missing meridiem from the close, and 24-hour times", () => {
    expect(read(`<p>Open daily 7am - 3pm</p>`)?.weekly).toHaveLength(7);
    const x = read(`<p>Tue-Sun 5-10pm</p><p>Monday: Closed</p>`);
    expect(x?.weekly).toHaveLength(6);
    expect(x?.weekly[0]).toEqual({ weekday: 0, startMin: h(17), endMin: h(22) });
    expect(read(`<p>Mon-Sat 11-10pm</p>`)?.weekly[0]).toEqual({ weekday: 1, startMin: h(11), endMin: h(22) });
    expect(read(`<p>Mon-Sun 08:00 - 22:00</p>`)?.weekly).toHaveLength(7);
  });

  it("leaves out hours under a heading for something else or a season, however much copy comes between, until the section ends (PR #57 review)", () => {
    for (const heading of ["Delivery Hours", "Kitchen Hours", "Office Hours", "Summer Hours"]) {
      const body = `<section><h2>${heading}</h2><p>See our schedule below</p><p>123 Main Street</p><a>Order now</a><p>Mon-Sun 9am-9pm</p></section>`;
      expect(read(body), heading).toBeNull();
    }
    // A heading for the venue's own hours reads, and so does a section after the excluded one ends.
    expect(read(`<section><h2>Hours</h2><p>Come see us</p><p>Mon-Sun 9am-9pm</p></section>`)?.weekly).toHaveLength(7);
    const after = read(`<section><h2>Delivery Hours</h2><p>Mon-Fri 5pm-9pm</p></section><section><p>Our dining room</p><p>Mon-Sun 11am-10pm</p></section>`);
    expect(after?.weekly).toHaveLength(7);
    expect(after?.weekly[0]).toMatchObject({ startMin: h(11), endMin: h(22) });
    // A new heading ends the last one's scope.
    expect(read(`<h2>Catering</h2><p>Call us for events</p><h2>Visit us</h2><p>Mon-Sun 9am-9pm</p>`)?.weekly).toHaveLength(7);
    expect(visibleText(page(`<h2>Delivery <b>Hours</b></h2><p>x</p>`)).heading).toEqual([true, false]);
  });

  it("reads nothing it would have to guess", () => {
    // No meridiem at all, and not 24-hour times.
    expect(read(`<p>Mon-Fri 11-10</p>`)).toBeNull();
    // Happy hour, delivery and kitchen hours are not the doors' hours, inline or under a heading.
    expect(read(`<p>Happy Hour Mon-Fri 4pm-7pm</p>`)).toBeNull();
    expect(read(`<h4>Delivery hours</h4><p>Mon-Sun 11am-11pm</p>`)).toBeNull();
    expect(read(`<p>Kitchen: Mon-Sat 5pm-11pm</p>`)).toBeNull();
    // A caption under the block says what it is.
    expect(read(`<p>Burgers</p><p>Monday – Friday 3pm-6pm</p><p>Saturday 3pm-5pm</p><p>Sunday 11:30 AM - 3pm</p><p>Happy Hour</p>`)).toBeNull();
    // A season's hours are not this week's.
    expect(read(`<h4>Summer Hours</h4><p>Mon-Sun 10am-9pm</p>`)).toBeNull();
    // Weekdays only, nothing said of the weekend: an office's hours.
    expect(read(`<p>Monday through Friday 9 a.m. - 5 p.m.</p>`)).toBeNull();
    // Two locations' hours on one page disagree for a day.
    expect(read(`<p>Rye: Mon-Fri 11am-9pm</p><p>Port Chester: Mon-Fri 11am-10pm</p>`)).toBeNull();
    // Too little to be a week's hours, and prose with no times.
    expect(read(`<p>Mon-Fri 11am-10pm</p><p>Sun: closed</p><p>Sun 1pm-5pm</p>`)).toBeNull();
    expect(read(`<p>Saturday 10am-2pm</p>`)).toBeNull();
    expect(read(`<p>Hours: whenever we feel like it. Monday is our favourite day.</p>`)).toBeNull();
  });
});

describe("microdata and hours links", () => {
  it("reads itemprop=openingHours from content, datetime or text", () => {
    expect(microdataHours(`<meta itemprop="openingHours" content="Mo-Fr 11:00-22:00"><time itemprop='openingHours' datetime="Sa 12:00-23:00">Sat</time><span itemprop="openingHours">Su 12:00-21:00</span>`)).toEqual(["Mo-Fr 11:00-22:00", "Sa 12:00-23:00", "Su 12:00-21:00"]);
  });

  it("finds the site's own hours page first, never another site's or a file", () => {
    const html = `<a href="/contact">Contact</a><a href="https://other.example/hours">Hours</a><a href="/visit#top">Plan your visit</a><a href="/hours-and-location">Hours &amp; Location</a><a href="/menu.pdf">Hours (PDF)</a><a href="mailto:x@y.z">hours</a>`;
    expect(hoursLinks(html, "https://www.venue.example/")).toEqual(["https://www.venue.example/hours-and-location", "https://www.venue.example/visit", "https://www.venue.example/contact"]);
  });
});

describe("crafted pages read in linear time", () => {
  it("reads a line of many days without trying every way to split it (it was 2^n)", () => {
    const t0 = performance.now();
    // 48 day names on one line: exponential before (24 of them took 19 s), milliseconds now.
    expect(hoursFromText(["Tues, ".repeat(48) + "x"])).toBeNull();
    expect(hoursFromText(["Thurs/".repeat(48) + "x"])).toBeNull();
    expect(hoursFromText(visibleLines(page(`<p>${"Tues & Thurs, ".repeat(20)}x</p>`)))).toBeNull();
    expect(performance.now() - t0).toBeLessThan(500);
    // Every spelling still reads.
    expect(read(`<p>Tues & Thurs: 9am - 5pm</p><p>Mons, Weds, Fris: 10am - 4pm</p><p>Saturdays and Sundays: noon - 6pm</p>`)?.weekly).toHaveLength(7);
    expect(read(`<p>Thur - Sun: 11am - 10pm</p><p>Tue-Wed: 5pm - 10pm</p>`)?.weekly.map((x) => x.weekday)).toEqual([0, 2, 3, 4, 5, 6]);
  });

  it("looks for microdata's tag nearby only (a megabyte of bare attributes took 26 s)", () => {
    const t0 = performance.now();
    expect(microdataHours("<" + 'itemprop="openingHours" '.repeat(40_000) + ">")).toEqual([]);
    expect(microdataHours('itemprop="openingHours" '.repeat(40_000))).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(microdataHours(`${"<p>x</p>".repeat(1000)}<meta itemprop="openingHours" content="Mo-Fr 09:00-17:00">`)).toEqual(["Mo-Fr 09:00-17:00"]);
  });
});
