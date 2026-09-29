import { describe, expect, it } from "vitest";
import type { Photo } from "@outrn/contracts";
import { photosFor } from "./photos";

const photo = (over: Partial<Photo> = {}): Photo => ({
  url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/0/06/Lozupone_katz2.png/960px-Lozupone_katz2.png",
  width: 960,
  height: 720,
  alt: "The counter",
  credit: "Alex Lozupone, CC BY-SA 4.0",
  author: "Alex Lozupone",
  license: "CC BY-SA 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0",
  sourceUrl: "https://commons.wikimedia.org/wiki/File:Lozupone_katz2.png",
  ...over,
});
const stock = [{ source: "cafe.jpg", credit: "Unsplash", url: "https://images.unsplash.com/photo-1" }];
const remote = (uri: string) => `remote:${uri}`;

describe("which photos a place shows", () => {
  it("its own first, each with its credit and a description for screen readers", () => {
    const shown = photosFor("Katz's Delicatessen", "Restaurant", [photo(), photo({ alt: null })], stock, remote);
    expect(shown.map((p) => p.kind)).toEqual(["place", "place"]);
    expect(shown[0]).toMatchObject({ source: `remote:${photo().url}`, credit: "Alex Lozupone, CC BY-SA 4.0", creditUrl: photo().sourceUrl, alt: "Katz's Delicatessen: The counter" });
    expect(shown[1]!.alt).toBe("Photo 2 of Katz's Delicatessen");
  });

  it("without any, representative ones, never passed off as the place", () => {
    const shown = photosFor("Rex", "Cafe", [], stock, remote);
    expect(shown).toEqual([{ source: "cafe.jpg", kind: "representative", credit: "Unsplash", creditUrl: "https://images.unsplash.com/photo-1", alt: "A representative photo of a cafe, not Rex" }]);
    expect(photosFor("Rex", "Cafe", undefined, [], remote)).toEqual([]);
  });
});
