import { describe, expect, it } from "vitest";
import {
  ageLabel,
  actionLabel,
  clock,
  isExpired,
  priceLabel,
  safeExternalUrl,
} from "./presentation";
describe("truthful mobile presentation", () => {
  it("keeps booking and check-first cues on otherwise feasible activities", () => {
    expect(actionLabel({ status: "ready", callToAction: "book" })).toBe(
      "Book first",
    );
    expect(actionLabel({ status: "check_first", callToAction: "book" })).toBe(
      "Book first",
    );
    expect(actionLabel({ status: "check_first", callToAction: "go" })).toBe(
      "Check first",
    );
    expect(actionLabel({ status: "ready", callToAction: "check" })).toBe(
      "Check first",
    );
  });
  it("distinguishes unknown, estimated and reported prices", () => {
    expect(priceLabel({ kind: "unknown" })).toBe("Price unknown");
    expect(priceLabel({ kind: "free", evidence: "estimate" })).toBe(
      "Est. Free",
    );
    expect(priceLabel({ kind: "free", evidence: "reported" })).toBe(
      "Reported: Free",
    );
    expect(
      priceLabel({
        kind: "paid",
        minCents: null,
        maxCents: null,
        currency: "USD",
        per: "person",
        tier: null,
        evidence: "published",
      }),
    ).toContain("amount unknown");
    expect(
      priceLabel({
        kind: "paid",
        minCents: 1250,
        maxCents: 2500,
        currency: "USD",
        per: "group",
        tier: null,
        evidence: "estimate",
      }),
    ).toBe("Est. $12.50–$25 / group");
  });
  it("does not promote an estimated age restriction into a rule", () => {
    expect(ageLabel({ minAge: 21, evidence: "estimate" })).toBe("Usually 21+");
    expect(ageLabel({ minAge: 18, evidence: "published" })).toBe("18+");
  });
  it("uses the area timezone, including daylight-saving transitions", () => {
    expect(clock("2026-11-01T06:30:00Z", "America/New_York")).toBe("1:30 AM");
    expect(clock("2026-11-01T06:30:00Z", "Europe/London")).toBe("6:30 AM");
  });
  it("expires precisely at the server deadline", () => {
    const response = { expiresAt: "2026-10-03T22:50:00Z" };
    expect(isExpired(response, Date.parse("2026-10-03T22:49:59Z"))).toBe(false);
    expect(isExpired(response, Date.parse(response.expiresAt))).toBe(true);
  });
  it("allows web directions and valid phone links but rejects arbitrary schemes", () => {
    expect(safeExternalUrl("https://maps.google.com/?q=40,-73")).toContain(
      "https://",
    );
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("file:///private")).toBeNull();
    expect(safeExternalUrl("+1 (212) 555-1234", true)).toBe("tel:+12125551234");
    expect(safeExternalUrl("123;evil", true)).toBeNull();
  });
});
