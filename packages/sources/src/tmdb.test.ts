import { describe, expect, it } from "vitest";
import { mergeFilms, parseFilmsCapture, parseTmdbPage } from "./tmdb.js";

/** Replies in the shape TMDB documents (/movie/now_playing, /trending/movie/week). */

const movie = (over: Record<string, unknown> = {}) => ({ adult: false, id: 402431, title: "Wicked", original_title: "Wicked", popularity: 812.4, release_date: "2026-11-21", vote_average: 7.4, ...over });

describe("TMDB films", () => {
  it("reads a page: each film's id, titles, popularity and release date; leaves out adult titles and what isn't a film", () => {
    const page = parseTmdbPage({ page: 1, total_pages: 3, total_results: 60, results: [movie(), movie({ id: 2, title: "X", adult: true }), { id: "nope" }, movie({ id: 3, title: "Anora", original_title: "Anora", popularity: undefined, release_date: "" })] });
    expect(page.totalPages).toBe(3);
    expect(page.films).toEqual([
      { id: 402431, title: "Wicked", originalTitle: "Wicked", popularity: 812.4, releaseDate: "2026-11-21" },
      { id: 3, title: "Anora", originalTitle: "Anora", popularity: 0, releaseDate: null },
    ]);
  });

  it("merges the lists: each film once, at its most popular reading, most popular first", () => {
    const a = { id: 1, title: "A", originalTitle: null, popularity: 10, releaseDate: null };
    const b = { id: 2, title: "B", originalTitle: null, popularity: 50, releaseDate: null };
    expect(mergeFilms([[a, b], [{ ...a, popularity: 80 }]]).map((f) => [f.id, f.popularity])).toEqual([[1, 80], [2, 50]]);
  });

  it("a capture holds the films as read, never a key", () => {
    const c = { outrn_capture: "tmdb-films", fetchedAt: "2026-10-29T16:00:00.000Z", films: [{ id: 1, title: "A", originalTitle: null, popularity: 1, releaseDate: null }] };
    expect(parseFilmsCapture(c, "f.json").films).toHaveLength(1);
    expect(() => parseFilmsCapture({ ...c, outrn_capture: "other" }, "f.json")).toThrow(/not a TMDB films capture/);
  });
});
