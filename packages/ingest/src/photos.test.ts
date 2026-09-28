import { describe, expect, it } from "vitest";
import type { CommonsFile } from "@outrn/sources";
import { photoFrom, plainText, taggedFiles } from "./photos.js";

const file = (meta: Record<string, string>, over: Partial<CommonsFile> = {}): CommonsFile => ({
  title: "File:Pitt Park.jpg",
  mime: "image/jpeg",
  thumbUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Pitt_Park.jpg/800px-Pitt_Park.jpg",
  thumbWidth: 800,
  thumbHeight: 600,
  descriptionUrl: "https://commons.wikimedia.org/wiki/File:Pitt_Park.jpg",
  meta,
  ...over,
});

describe("which Commons files may be shown", () => {
  it("a freely licensed photo, credited as its license asks", () => {
    expect(photoFrom(file({ Artist: '<a href="//commons.wikimedia.org/wiki/User:Jane">Jane Doe</a>', LicenseShortName: "CC BY-SA 4.0", LicenseUrl: "https://creativecommons.org/licenses/by-sa/4.0", ImageDescription: "The lawn &amp; trees" }), "osm:wikimedia_commons")).toEqual({
      title: "File:Pitt Park.jpg",
      url: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Pitt_Park.jpg/800px-Pitt_Park.jpg",
      width: 800,
      height: 600,
      author: "Jane Doe",
      license: "CC BY-SA 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0",
      sourceUrl: "https://commons.wikimedia.org/wiki/File:Pitt_Park.jpg",
      alt: "The lawn & trees",
      via: "osm:wikimedia_commons",
    });
    // Public domain and CC0 need no credit; an http license link is upgraded.
    expect(photoFrom(file({ LicenseShortName: "Public domain" }), "x")).toMatchObject({ license: "Public domain", author: null });
    expect(photoFrom(file({ LicenseShortName: "CC0", LicenseUrl: "http://creativecommons.org/publicdomain/zero/1.0/" }), "x")).toMatchObject({ license: "CC0", licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/" });
    expect(photoFrom(file({ Artist: "A", LicenseShortName: "cc by 2.0 de" }), "x")?.license).toBe("CC BY 2.0 de");
  });

  it("never a non-free, unlicensed or uncredited file, a drawing, or one served from elsewhere", () => {
    expect(photoFrom(file({ Artist: "A", LicenseShortName: "CC BY-SA 4.0", NonFree: "true" }), "x")).toBeNull();
    expect(photoFrom(file({ Artist: "A", LicenseShortName: "Fair use" }), "x")).toBeNull();
    expect(photoFrom(file({ Artist: "A", LicenseShortName: "GFDL" }), "x")).toBeNull();
    expect(photoFrom(file({ Artist: "A", LicenseShortName: "CC BY-NC 2.0" }), "x")).toBeNull();
    expect(photoFrom(file({ Artist: "A" }), "x")).toBeNull();
    expect(photoFrom(file({ LicenseShortName: "CC BY 2.0" }), "x")).toBeNull(); // needs a credit, has none
    expect(photoFrom(file({ Artist: "<span> </span>", LicenseShortName: "CC BY 2.0" }), "x")).toBeNull();
    expect(photoFrom(file({ LicenseShortName: "CC0" }, { mime: "image/svg+xml" }), "x")).toBeNull();
    expect(photoFrom(file({ LicenseShortName: "CC0" }, { thumbUrl: "https://evil.example/t.jpg" }), "x")).toBeNull();
    expect(photoFrom(file({ LicenseShortName: "CC0" }, { descriptionUrl: "https://evil.example/page" }), "x")).toBeNull();
    expect(photoFrom(file({ LicenseShortName: "CC0" }, { thumbWidth: 0 }), "x")).toBeNull();
  });

  it("keeps a license link only on the license's own hosts", () => {
    expect(photoFrom(file({ LicenseShortName: "CC0", LicenseUrl: "https://evil.example/license" }), "x")?.licenseUrl).toBeNull();
  });
});

describe("text from Commons' HTML metadata", () => {
  it("keeps an entity that names no character as written, instead of throwing: metadata is external input", () => {
    for (const bad of ["&#1114112;", "&#x110000;", "&#xD800;", "&#57343;", "&#0;", "&#99999999999999999999;"]) {
      expect(() => plainText(`Jane ${bad} Doe`, 100), bad).not.toThrow();
      expect(plainText(`Jane ${bad} Doe`, 100), bad).toBe(`Jane ${bad} Doe`);
    }
    expect(plainText("Ren&#233;e &#x1F4F7;", 100)).toBe("Renée 📷");
    // Through photoFrom too: a malformed credit is shown as written, never a crash.
    expect(photoFrom(file({ Artist: "&#1114112;", LicenseShortName: "CC BY 4.0", ImageDescription: "&#xD800; lawn" }), "osm:image")).toMatchObject({ author: "&#1114112;", alt: "&#xD800; lawn" });
  });

  it("drops tags, decodes entities, collapses space, and truncates", () => {
    expect(plainText("<b>Jane</b>&nbsp;&amp;&#32;<i>John</i>&#x21;", 100)).toBe("Jane & John!");
    expect(plainText("  <br/> ", 100)).toBeNull();
    expect(plainText("abcdefghij", 6)).toBe("abcde…");
    expect(plainText(undefined, 10)).toBeNull();
  });
});

describe("files a venue's tags name", () => {
  it("wikimedia_commons files first, then Commons image links, in the mapper's order; categories and other hosts are not photos of it", () => {
    expect(taggedFiles({ wikimedia_commons: "File:A.jpg; Category:Park;File:B.jpg", image: "https://example.com/c.jpg;https://commons.wikimedia.org/wiki/File:D.jpg" })).toEqual([
      { title: "File:A.jpg", via: "osm:wikimedia_commons" },
      { title: "File:B.jpg", via: "osm:wikimedia_commons" },
      { title: "File:D.jpg", via: "osm:image" },
    ]);
    expect(taggedFiles({ wikimedia_commons: "https://commons.wikimedia.org/wiki/File:E.jpg" })).toEqual([]);
  });
});
