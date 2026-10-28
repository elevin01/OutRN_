import { describe, expect, it } from "vitest";
import {
  EMPTY_TASTE,
  MAX_TASTE,
  learn,
  nextPick,
  parseTaste,
  pickOf,
  PICK_WEIGHT,
  requestTaste,
  setPick,
} from "./taste";

describe("taste kept on this device", () => {
  it("starts empty and unasked, and reads a stored profile without trusting it", () => {
    expect(parseTaste(null)).toEqual(EMPTY_TASTE);
    expect(parseTaste("nonsense")).toEqual(EMPTY_TASTE);
    // As it comes back from storage: JSON, where "__proto__" is an own key.
    const stored = parseTaste(
      JSON.parse(
        '{"asked":true,"weights":{"art":0.8,"drinks":-2,"live_music":null,"__proto__":1,"Bad Id":1,"comedy":0,"film":"1"}}',
      ),
    );
    expect(stored.asked).toBe(true);
    expect({ ...stored.weights }).toEqual({ art: 0.8, drinks: -1 });
    expect(Object.getPrototypeOf(stored.weights)).toBeNull();
    // Never more than the API takes.
    const many = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`i${"x".repeat(i)}`.slice(0, 40), 0.5]),
    );
    expect(Object.keys(parseTaste({ weights: many }).weights).length).toBe(MAX_TASTE);
  });

  it("cycles a quick pick through like, skip and none", () => {
    let t = EMPTY_TASTE;
    expect(pickOf(t, "art")).toBe("none");
    t = setPick(t, "art", nextPick(pickOf(t, "art")));
    expect([pickOf(t, "art"), t.weights["art"]]).toEqual(["like", PICK_WEIGHT]);
    t = setPick(t, "art", nextPick(pickOf(t, "art")));
    expect([pickOf(t, "art"), t.weights["art"]]).toEqual(["skip", -PICK_WEIGHT]);
    t = setPick(t, "art", nextPick(pickOf(t, "art")));
    expect(pickOf(t, "art")).toBe("none");
    expect("art" in t.weights).toBe(false);
  });

  it("learns from going, saving and turning down, by what the option is", () => {
    let t = learn(EMPTY_TASTE, ["live_music", "outdoors", "festivals"], "go");
    // What it is, not everything it touches: the first two.
    expect({ ...t.weights }).toEqual({ live_music: 0.2, outdoors: 0.2 });
    t = learn(t, ["live_music"], "save");
    expect(t.weights["live_music"]).toBe(0.3);
    t = learn(t, ["live_music"], "unsave");
    expect(t.weights["live_music"]).toBe(0.2);
    t = learn(t, ["drinks"], "not_for_me");
    expect(t.weights["drinks"]).toBe(-0.15);
    // Bounded, and a weight that returns to nothing is dropped.
    for (let i = 0; i < 10; i++) t = learn(t, ["art"], "go");
    expect(t.weights["art"]).toBe(1);
    t = learn(learn(EMPTY_TASTE, ["film"], "save"), ["film"], "unsave");
    expect("film" in t.weights).toBe(false);
    // Nothing to learn from: the same profile back.
    expect(learn(EMPTY_TASTE, [], "go")).toBe(EMPTY_TASTE);
  });

  it("sends offered interests only, strongest first", () => {
    const t = parseTaste({ asked: true, weights: { art: 0.3, drinks: -1, teleportation: 1, books: 0.8 } });
    expect(requestTaste(t, ["art", "drinks", "books"])).toEqual([
      { interest: "drinks", weight: -1 },
      { interest: "books", weight: 0.8 },
      { interest: "art", weight: 0.3 },
    ]);
    expect(requestTaste(EMPTY_TASTE)).toEqual([]);
  });
});
