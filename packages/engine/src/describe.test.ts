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
    expect(formatFactValue("scheduled_closure", { at: "2026-11-10T05:00:00.000Z" }, false, TZ)).toBe("Closes permanently Nov 10, 2026"); // local midnight
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
    const [hours] = describeFacts({ opening_hours: rec({ value: { osm: "Mo-Su 16:00-04:00" }, sources: ["founder", "osm"], asOf: new Date("2026-09-26T20:00:00Z"), verifiedAt: new Date("2026-09-26T12:00:00Z") }) }, { tz: TZ, point: P, now: NOW });
    expect(hours).toMatchObject({ label: "Hours", value: "Mo-Su 16:00-04:00", detail: "Open now until 4am", source: "OutRN + OpenStreetMap", age: "confirmed Sep 26", evidence: "published" });
    const [osm] = describeFacts({ opening_hours: rec({ value: { osm: "Mo-Su 16:00-04:00" } }) }, { tz: TZ, point: P, now: NOW });
    expect(osm!.age).not.toMatch(/confirm|verif/);
    const [site] = describeFacts({ opening_hours: rec({ value: { osm: "Mo-Su 16:00-04:00" }, sources: ["firstparty"], asOf: null }) }, { tz: TZ, point: P, now: NOW });
    expect(site).toMatchObject({ source: "venue website", age: "retrieved Sep 26" });
  });

  it("the confirmed date is the check, not a later OSM edit of the same value; old checks are due for recheck", () => {
    const agreed = rec({ value: { osm: "Mo-Su 16:00-04:00" }, sources: ["founder", "osm"], asOf: new Date("2026-09-20T12:00:00Z"), verifiedAt: new Date("2026-06-01T12:00:00Z") });
    const [row] = describeFacts({ opening_hours: agreed }, { tz: TZ, point: P, now: NOW });
    expect(row!.age).toBe("confirmed Jun 1 · due for recheck");
    const [fresh] = describeFacts({ opening_hours: { ...agreed, verifiedAt: new Date("2026-09-01T12:00:00Z") } }, { tz: TZ, point: P, now: NOW });
    expect(fresh!.age).toBe("confirmed Sep 1");
  });

  it("kind and age-limit rows always show a supplied minimum age", () => {
    expect(formatFactValue("age_limit", { minAge: 0 })).toBe("All ages");
    expect(formatFactValue("age_limit", { minAge: 16 })).toBe("16+");
    expect(formatFactValue("age_limit", { minAge: 18 })).toBe("18+ (adults only)");
    expect(formatFactValue("age_limit", { minAge: 21 })).toBe("21+ (adults only)");
    expect(formatFactValue("age_limit", { minAge: 21 }, true)).toBe("Usually 21+ (adults only)");
    expect(formatFactValue("subtype", { value: "miniature_golf" })).toBe("Miniature golf");
    const rows = describeFacts({ age_limit: rec({ value: { minAge: 21 }, evidenceClass: "estimate" }), subtype: rec({ value: { value: "casino" } }), opening_hours: rec({ value: { osm: "24/7" } }) }, { tz: TZ, point: P, now: NOW });
    expect(rows.map((r) => r.label)).toEqual(["Hours", "Kind", "Age limit"]);
  });

  it("a mapper's survey reads as one, is never 'confirmed', and a later edit is named", () => {
    const [hours] = describeFacts({ opening_hours: rec({ value: { osm: "Mo-Su 16:00-04:00" }, asOf: new Date("2026-03-12T12:00:00Z"), surveyedAt: new Date("2026-03-10T00:00:00Z") }) }, { tz: TZ, point: P, now: NOW });
    expect(hours!.age).toBe("checked by an OSM mapper Mar 2026");
    expect(hours!.age).not.toMatch(/confirmed/);
    // A name fix in September, hours surveyed in March: both dates, because the edit may have touched the hours.
    const [later] = describeFacts({ opening_hours: rec({ value: { osm: "Mo-Su 16:00-04:00" }, asOf: new Date("2026-09-01T12:00:00Z"), surveyedAt: new Date("2026-03-10T00:00:00Z") }) }, { tz: TZ, point: P, now: NOW });
    expect(later!.age).toBe("checked by an OSM mapper Mar 2026 · last edited Sep 2026");
    // Our own check still outranks it.
    const [ours] = describeFacts({ opening_hours: rec({ value: { osm: "Mo-Su 16:00-04:00" }, surveyedAt: new Date("2026-03-10T00:00:00Z"), verifiedAt: new Date("2026-09-20T12:00:00Z") }) }, { tz: TZ, point: P, now: NOW });
    expect(ours!.age).toBe("confirmed Sep 20");
  });

  it("kitchen hours sit under the hours, with today's state", () => {
    const rows = describeFacts({ opening_hours: rec({ value: { osm: "Mo-Su 12:00-23:00" } }), kitchen_hours: rec({ value: { osm: "Mo-Su 12:00-22:00" } }) }, { tz: TZ, point: P, now: NOW });
    expect(rows.map((r) => r.attribute)).toEqual(["opening_hours", "kitchen_hours"]);
    expect(rows[1]).toMatchObject({ label: "Kitchen", value: "Mo-Su 12:00-22:00", detail: "Open now until 10pm" });
  });
});

