import { describe, expect, it } from "vitest";
import type { Photo } from "@outrn/contracts";
import { photosFor, photosToShow } from "./photos";

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
    expect(shown).toEqual([{ key: "https://images.unsplash.com/photo-1", source: "cafe.jpg", kind: "representative", credit: "Unsplash", creditUrl: "https://images.unsplash.com/photo-1", alt: "A representative photo of a cafe, not Rex" }]);
    expect(photosFor("Rex", "Cafe", undefined, [], remote)).toEqual([]);
  });

  it("loads only https photos on Wikimedia's image hosts, and links the credit only over https", () => {
    for (const url of ["http://thumb.wikimedia.org/wikipedia/commons/a.jpg", "https://tracker.example/pixel.gif", "file:///etc/hosts", "data:image/png;base64,AAAA", "https://user:pw@upload.wikimedia.org/wikipedia/commons/a.jpg", "https://upload.wikimedia.org.evil.example/a.jpg"]) {
      expect(photosFor("Rex", "Cafe", [photo({ url })], stock, remote).map((p) => p.kind), url).toEqual(["representative"]);
    }
    for (const sourceUrl of ["javascript:alert(1)", "http://commons.wikimedia.org/wiki/File:A.jpg", "data:text/html,hi"]) {
      expect(photosFor("Rex", "Cafe", [photo({ sourceUrl })], stock, remote)[0], sourceUrl).toMatchObject({ kind: "place", creditUrl: null });
    }
    // One bad photo among good ones drops out alone.
    expect(photosFor("Rex", "Cafe", [photo({ url: "https://tracker.example/a.gif" }), photo()], stock, remote).map((p) => p.kind)).toEqual(["place"]);
  });

  it("when none of its own loads, representative ones, labelled; when none of those loads either, none", () => {
    const own = photosFor("Rex", "Cafe", [photo(), photo({ url: "https://upload.wikimedia.org/wikipedia/commons/b.jpg" })], stock, remote);
    const fallback = photosFor("Rex", "Cafe", undefined, stock, remote);
    expect(photosToShow(own, fallback, new Set())).toEqual(own);
    // One of its own fails: the other stays, with no stand-in beside it.
    expect(photosToShow(own, fallback, new Set([own[0]!.key]))).toEqual([own[1]]);
    const failedOwn = new Set(own.map((p) => p.key));
    expect(photosToShow(own, fallback, failedOwn)).toEqual(fallback);
    expect(photosToShow(own, fallback, failedOwn)[0]).toMatchObject({ kind: "representative", alt: "A representative photo of a cafe, not Rex" });
    expect(photosToShow(own, fallback, new Set([...failedOwn, fallback[0]!.key]))).toEqual([]);
    // A kind without representative photos: nothing, never a stand-in.
    expect(photosToShow(own, photosFor("Rex", "Park", undefined, [], remote), failedOwn)).toEqual([]);
    // A place showing representative photos already does not retry the same ones.
    expect(photosToShow(fallback, fallback, new Set([fallback[0]!.key]))).toEqual([]);
  });

  it("names the kind with the right article", () => {
    expect(photosFor("Rex", "Arts centre", [], stock, remote)[0]!.alt).toBe("A representative photo of an arts centre, not Rex");
  });
});

describe("an aerial photo as a place's stand-in", () => {
  const aerial = { url: "https://orthos.its.ny.gov/arcgis/rest/services/wms/Latest/MapServer/export?bbox=1,2,3,4&f=image", width: 800, height: 500, credit: "NYS ITS Geospatial Services orthoimagery", sourceUrl: "https://gis.ny.gov/orthoimagery" };

  it("stands in when a place has no photo of its own: first for a park, after the representative ones for a cafe", () => {
    expect(photosFor("Seward Park", "Park", [], [], remote, { aerial, categoryId: "park" })).toEqual([
      { key: aerial.url, source: `remote:${aerial.url}`, kind: "aerial", credit: aerial.credit, creditUrl: aerial.sourceUrl, alt: "An aerial view of where Seward Park is" },
    ]);
    expect(photosFor("Rex", "Cafe", [], stock, remote, { aerial, categoryId: "cafe" }).map((p) => p.kind)).toEqual(["representative", "aerial"]);
    expect(photosFor("Seward Park", "Park", [], stock, remote, { aerial, categoryId: "park" }).map((p) => p.kind)).toEqual(["aerial", "representative"]);
    // A place's own photos come first, alone.
    expect(photosFor("Rex", "Cafe", [photo()], stock, remote, { aerial, categoryId: "cafe" }).map((p) => p.kind)).toEqual(["place"]);
  });

  it("loads only over https from the state's server, and none when the API gives none", () => {
    for (const url of ["http://orthos.its.ny.gov/a", "https://orthos.its.ny.gov.evil.example/a", "https://user:pw@orthos.its.ny.gov/a", "https://upload.wikimedia.org/a.jpg", "file:///etc/hosts"]) {
      expect(photosFor("Seward Park", "Park", [], [], remote, { aerial: { ...aerial, url }, categoryId: "park" }), url).toEqual([]);
    }
    expect(photosFor("Seward Park", "Park", [], [], remote, { aerial: null, categoryId: "park" })).toEqual([]);
  });
});
