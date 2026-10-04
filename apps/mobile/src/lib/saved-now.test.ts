import { describe, expect, it, vi } from "vitest";
import { scenarios } from "@outrn/contracts/fixtures";
import { loadSavedMatches } from "./saved-now";

const base = scenarios[0].pages[0];
const venue = {
  ...base.items[0],
  kind: "venue" as const,
  status: "ready" as const,
};
const query = {
  areaId: "les",
  windowMinutes: 120,
  travelMode: "walk" as const,
  at: "2026-10-03T22:00:00Z",
};
const signal = () => new AbortController().signal;

describe("Saved Fits now API presentation", () => {
  it("follows frozen cursor pages and retains the backend's caveats, booking and age information", async () => {
    const later = {
      ...venue,
      id: "later",
      placeId: "saved",
      callToAction: "book" as const,
      ageLimit: { minAge: 18, evidence: "published" as const },
      caveats: [
        {
          code: "future-note",
          text: "Check admission with the venue",
          required: true,
        },
      ],
    };
    const first = {
      ...base,
      items: [],
      page: { ...base.page, offset: 0, nextCursor: "next" },
    };
    const second = {
      ...base,
      items: [later],
      page: { ...base.page, offset: 3, nextCursor: null },
    };
    const recommend = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const result = await loadSavedMatches(
      query,
      ["saved"],
      recommend,
      signal(),
    );
    expect(recommend.mock.calls[0][0]).toEqual({
      areaId: "les",
      windowMinutes: 120,
      travelMode: "walk",
    });
    expect(recommend.mock.calls[1][0]).toEqual({ cursor: "next" });
    expect(result.matches.saved).toEqual({ item: later, response: second });
    expect(query.at).toBe("2026-10-03T22:00:00Z");
  });
  it("never upgrades check-first or treats an event as a ready venue", async () => {
    const recommend = vi.fn().mockResolvedValue({
      ...base,
      items: [
        { ...venue, placeId: "uncertain", status: "check_first" },
        { ...venue, placeId: "event-only", kind: "event" },
        { ...venue, placeId: "ready" },
      ],
      page: { ...base.page, nextCursor: null },
    });
    const result = await loadSavedMatches(
      query,
      ["uncertain", "event-only", "ready", "not-returned"],
      recommend,
      signal(),
    );
    expect(Object.keys(result.matches)).toEqual(["ready"]);
  });
  it("reports a paging failure instead of presenting a partial search as complete", async () => {
    const recommend = vi
      .fn()
      .mockResolvedValueOnce({
        ...base,
        items: [],
        page: { ...base.page, nextCursor: "next" },
      })
      .mockRejectedValueOnce(new Error("Offline"));
    await expect(
      loadSavedMatches(query, ["saved"], recommend, signal()),
    ).rejects.toThrow("Offline");
  });
  it("rejects a changed snapshot or a non-advancing cursor", async () => {
    const page = {
      ...base,
      items: [],
      page: { ...base.page, offset: 0, nextCursor: "loop" },
    };
    await expect(
      loadSavedMatches(
        query,
        ["saved"],
        vi.fn().mockResolvedValue(page),
        signal(),
      ),
    ).rejects.toThrow("search changed");
  });
  it("discards aborted results", async () => {
    const controller = new AbortController();
    const recommend = vi.fn().mockImplementation(async () => {
      controller.abort();
      return base;
    });
    await expect(
      loadSavedMatches(query, ["saved"], recommend, controller.signal),
    ).rejects.toThrow("cancelled");
  });
});
