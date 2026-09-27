import { describe, expect, it } from "vitest";
import { fromLocal } from "@outrn/core";
import { describeFacts, formatFactValue, hoursToday, type FactRecord } from "./describe.js";

const TZ = "America/New_York";
const P = { lat: 40.941, lon: -73.835 };
const NOW = fromLocal("2026-09-26", 21 * 60 + 37, TZ); // Sat 9:37 pm
const rec = (over: Partial<FactRecord> & { value: unknown }): FactRecord => ({ confidence: 0.6, evidenceClass: "published", sources: ["osm"], asOf: new Date("2024-07-14T12:00:00Z"), fetchedAt: new Date("2026-09-27T01:00:00Z"), ...over });

describe("detail page facts", () => {
  it("formats status and admission as words, never JSON", () => {
    expect(formatFactValue("business_status", { status: "operating" })).toBe("Operating");
    expect(formatFactValue("business_status", { status: "closed_permanently" })).toBe("Closed permanently");
    expect(formatFactValue("admission", { requirement: "reservation_available" })).toBe("Walk in; reservations taken");
    expect(formatFactValue("price", { min: 10, max: 20, currency: "USD", basis: "per_person" }, true)).toBe("~$10–20 per person");
    expect(formatFactValue("price", { currency: "USD", free: true }, true)).toBe("Usually free");
    expect(formatFactValue("opening_hours", { weekly: [{ weekday: 1, startMin: 16 * 60, endMin: 28 * 60 }] })).toBe("Mon 4pm–4am");
    expect(formatFactValue("mystery", { a: 1 })).not.toMatch(/[{}"]/);
  });

  it("hours today, including overnight intervals", () => {
    expect(hoursToday({ osm: "Mo-Su 16:00-04:00" }, NOW, TZ, P)).toBe("Open now until 4am");
    expect(hoursToday({ osm: "Mo-Fr 06:00-15:00; Sa 08:00-14:00; Su off" }, NOW, TZ, P)).toBe("Closed now · opens Mon 6am");
    expect(hoursToday({ osm: "24/7" }, NOW, TZ, P)).toBe("Open 24/7");
    expect(hoursToday({ osm: "Mo-Su 22:00-02:00" }, NOW, TZ, P)).toBe("Closed now · opens 10pm today");
  });

  it("hours come first and are always present; each row names its source, age and evidence class", () => {
    const rows = describeFacts(
      {
        name: rec({ value: { value: "Pete's" } }),
        business_status: rec({ value: { status: "operating" }, evidenceClass: "estimate", confidence: 0.35 }),
        admission: rec({ value: { requirement: "walk_in" }, evidenceClass: "estimate" }),
      },
      { tz: TZ, point: P, now: NOW },
    );
    expect(rows[0]).toMatchObject({ attribute: "opening_hours", value: "Not listed", evidence: "missing" });
    expect(rows.map((r) => r.attribute)).toEqual(["opening_hours", "business_status", "admission"]);
    expect(rows[1]).toMatchObject({ value: "Operating", source: "OpenStreetMap", evidence: "estimate", age: "last edited in OSM Jul 2024" });
  });

  it("founder hours read as confirmed on the check date; OSM dates are never called verification", () => {
    const [hours] = describeFacts({ opening_hours: rec({ value: { osm: "Mo-Su 16:00-04:00" }, sources: ["founder"], asOf: new Date("2026-09-26T20:00:00Z") }) }, { tz: TZ, point: P, now: NOW });
    expect(hours).toMatchObject({ label: "Hours", value: "Mo-Su 16:00-04:00", detail: "Open now until 4am", source: "OutRN", age: "confirmed Sep 26", evidence: "published" });
    const [osm] = describeFacts({ opening_hours: rec({ value: { osm: "Mo-Su 16:00-04:00" } }) }, { tz: TZ, point: P, now: NOW });
    expect(osm!.age).not.toMatch(/confirm|verif/);
    const [site] = describeFacts({ opening_hours: rec({ value: { osm: "Mo-Su 16:00-04:00" }, sources: ["firstparty"], asOf: null }) }, { tz: TZ, point: P, now: NOW });
    expect(site).toMatchObject({ source: "venue website", age: "retrieved Sep 26" });
  });
});
