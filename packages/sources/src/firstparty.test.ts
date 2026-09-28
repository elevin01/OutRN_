import { describe, expect, it } from "vitest";
import { extractFromJsonLd, extractJsonLdBlocks, openingHoursFromSpec } from "./firstparty.js";

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

