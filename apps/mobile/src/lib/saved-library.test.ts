import { describe, expect, it } from "vitest";
import {
  MAX_SAVED,
  putCollection,
  readSavedLibrary,
  restorePlace,
  togglePlace,
  type SavedLibrary,
} from "./saved-library";

const cafe = { id: "cafe", name: "Corner café", category: "cafe" };
const park = { id: "park", name: "Riverside", category: "park" };
const library: SavedLibrary = {
  places: [cafe, park],
  collections: [{ id: "weekend", name: "Weekend", placeIds: ["cafe", "park"] }],
};

describe("device-local saved library", () => {
  it("reads legacy saves without retaining cached feasibility or other unknown fields", () => {
    expect(
      readSavedLibrary(
        null,
        JSON.stringify([
          { ...cafe, status: "ready" },
          cafe,
          null,
          { id: "broken" },
        ]),
      ),
    ).toEqual({ places: [cafe], collections: [] });
    expect(readSavedLibrary(null, null)).toEqual({
      places: [],
      collections: [],
    });
  });
  it("prefers the new library, so deleted legacy saves do not reappear", () => {
    expect(
      readSavedLibrary(
        JSON.stringify({ places: [], collections: [] }),
        JSON.stringify([cafe]),
      ),
    ).toEqual({ places: [], collections: [] });
  });
  it("rejects unreadable storage instead of silently overwriting it", () => {
    expect(() => readSavedLibrary("{broken", null)).toThrow();
    expect(() => readSavedLibrary("{}", JSON.stringify([cafe]))).toThrow();
    expect(() => readSavedLibrary(null, "{}")).toThrow();
  });
  it("removes a place from every collection, and Undo restores its position and memberships", () => {
    const removed = togglePlace(library, cafe);
    expect(removed).toEqual({
      places: [park],
      collections: [{ id: "weekend", name: "Weekend", placeIds: ["park"] }],
    });
    const restored = restorePlace(removed, {
      place: cafe,
      index: 0,
      collectionIds: ["weekend"],
    });
    expect(restored.places).toEqual(library.places);
    expect(new Set(restored.collections[0].placeIds)).toEqual(
      new Set(["park", "cafe"]),
    );
    expect(library.collections[0].placeIds).toEqual(["cafe", "park"]);
  });
  it("prunes invalid memberships and duplicate ids without losing valid collections", () => {
    const decoded = readSavedLibrary(
      JSON.stringify({
        ...library,
        collections: [
          {
            id: "weekend",
            name: " Weekend ",
            placeIds: ["park", "park", "missing"],
          },
        ],
      }),
      null,
    );
    expect(decoded.collections).toEqual([
      { id: "weekend", name: "Weekend", placeIds: ["park"] },
    ]);
    const edited = putCollection(library, {
      id: "weekend",
      name: " After work ",
      placeIds: ["cafe", "cafe", "missing"],
    });
    expect(edited.collections).toEqual([
      { id: "weekend", name: "After work", placeIds: ["cafe"] },
    ]);
    expect(edited.places).toEqual(library.places);
  });
  it("cleans collection references when the existing 200-save limit evicts a place", () => {
    const places = Array.from({ length: MAX_SAVED }, (_, i) => ({
      ...cafe,
      id: String(i),
    }));
    const next = togglePlace(
      {
        places,
        collections: [
          { id: "last", name: "Last", placeIds: [String(MAX_SAVED - 1)] },
        ],
      },
      park,
    );
    expect(next.places).toHaveLength(MAX_SAVED);
    expect(next.collections[0].placeIds).toEqual([]);
  });
});
