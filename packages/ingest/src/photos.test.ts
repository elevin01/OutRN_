import { describe, expect, it } from "vitest";
import type { CommonsFile } from "@outrn/sources";
import { MIN_FILE_AGE_DAYS, photoFrom, plainText, taggedFiles } from "./photos.js";

const NOW = new Date("2026-09-26T12:00:00Z");
const daysBefore = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const file = (meta: Record<string, string>, over: Partial<CommonsFile> = {}): CommonsFile => ({
  title: "File:Pitt Park.jpg",
  mime: "image/jpeg",
  thumbUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Pitt_Park.jpg/800px-Pitt_Park.jpg",
  thumbWidth: 800,
  thumbHeight: 600,
  descriptionUrl: "https://commons.wikimedia.org/wiki/File:Pitt_Park.jpg",
  uploadedAt: "2019-05-04T12:00:00Z",
  deletionTags: [],
  meta,
  ...over,
});

describe("which Commons files may be shown", () => {
  it("a freely licensed photo, credited as its license asks", () => {
    expect(photoFrom(file({ Artist: '<a href="//commons.wikimedia.org/wiki/User:Jane">Jane Doe</a>', LicenseShortName: "CC BY-SA 4.0", LicenseUrl: "https://creativecommons.org/licenses/by-sa/4.0", ImageDescription: "The lawn &amp; trees" }), "osm:wikimedia_commons", NOW)).toEqual({
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
    expect(photoFrom(file({ LicenseShortName: "Public domain" }), "x", NOW)).toMatchObject({ license: "Public domain", author: null });
    expect(photoFrom(file({ LicenseShortName: "CC0", LicenseUrl: "http://creativecommons.org/publicdomain/zero/1.0/" }), "x", NOW)).toMatchObject({ license: "CC0", licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/" });
    expect(photoFrom(file({ Artist: "A", LicenseShortName: "cc by 2.0 de" }), "x", NOW)?.license).toBe("CC BY 2.0 de");
  });

  it("never a non-free, unlicensed or uncredited file, a drawing, or one served from elsewhere", () => {
    expect(photoFrom(file({ Artist: "A", LicenseShortName: "CC BY-SA 4.0", NonFree: "true" }), "x", NOW)).toBeNull();
    expect(photoFrom(file({ Artist: "A", LicenseShortName: "Fair use" }), "x", NOW)).toBeNull();
    expect(photoFrom(file({ Artist: "A", LicenseShortName: "GFDL" }), "x", NOW)).toBeNull();
    expect(photoFrom(file({ Artist: "A", LicenseShortName: "CC BY-NC 2.0" }), "x", NOW)).toBeNull();
    expect(photoFrom(file({ Artist: "A" }), "x", NOW)).toBeNull();
    expect(photoFrom(file({ LicenseShortName: "CC BY 2.0" }), "x", NOW)).toBeNull(); // needs a credit, has none
    expect(photoFrom(file({ Artist: "<span> </span>", LicenseShortName: "CC BY 2.0" }), "x", NOW)).toBeNull();
    expect(photoFrom(file({ LicenseShortName: "CC0" }, { mime: "image/svg+xml" }), "x", NOW)).toBeNull();
    expect(photoFrom(file({ LicenseShortName: "CC0" }, { thumbUrl: "https://evil.example/t.jpg" }), "x", NOW)).toBeNull();
    expect(photoFrom(file({ LicenseShortName: "CC0" }, { descriptionUrl: "https://evil.example/page" }), "x", NOW)).toBeNull();
    expect(photoFrom(file({ LicenseShortName: "CC0" }, { thumbWidth: 0 }), "x", NOW)).toBeNull();
  });

  it(`only once a file has been on Commons, as it is now, for ${MIN_FILE_AGE_DAYS} days, and not while it is tagged for deletion`, () => {
    const cc0 = { LicenseShortName: "CC0" };
    expect(photoFrom(file(cc0, { uploadedAt: daysBefore(MIN_FILE_AGE_DAYS) }), "x", NOW)).not.toBeNull();
    // A fresh upload (a "scan to order" code, say) or a fresh version over an old file waits.
    expect(photoFrom(file(cc0, { uploadedAt: daysBefore(MIN_FILE_AGE_DAYS - 1) }), "x", NOW)).toBeNull();
    expect(photoFrom(file(cc0, { uploadedAt: daysBefore(-1) }), "x", NOW)).toBeNull();
    // No upload time, or one that doesn't read: not shown.
    expect(photoFrom(file(cc0, { uploadedAt: null }), "x", NOW)).toBeNull();
    expect(photoFrom(file(cc0, { uploadedAt: "last week" }), "x", NOW)).toBeNull();
    expect(photoFrom(file(cc0, { deletionTags: ["Template:Delete"] }), "x", NOW)).toBeNull();
    expect(photoFrom(file(cc0, { deletionTags: ["Template:Copyvio"] }), "x", NOW)).toBeNull();
  });

  it("from Wikimedia's image servers as Commons serves them now: thumb.wikimedia.org, without its analytics parameters", () => {
    // The thumbnail address Commons returned for Katz's photo (Q2611788) in the live check on 2026-09-28.
    const katz = file(
      { Artist: "A photographer", LicenseShortName: "CC BY-SA 4.0" },
      {
        title: "File:Lozupone katz2.png",
        mime: "image/png",
        thumbUrl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/0/06/Lozupone_katz2.png/960px-Lozupone_katz2.png?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail",
        thumbWidth: 960,
        thumbHeight: 720,
        descriptionUrl: "https://commons.wikimedia.org/wiki/File:Lozupone_katz2.png",
        uploadedAt: "2016-12-25T17:38:51Z",
      },
    );
    expect(photoFrom(katz, "wikidata:P18", NOW)).toMatchObject({ url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/0/06/Lozupone_katz2.png/960px-Lozupone_katz2.png", width: 960, license: "CC BY-SA 4.0" });
    // Other parameters are kept; only the analytics ones go.
    expect(photoFrom(file({ LicenseShortName: "CC0" }, { thumbUrl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/P.jpg/960px-P.jpg?UTM_Source=x&lang=en" }), "x", NOW)?.url).toBe("https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/P.jpg/960px-P.jpg?lang=en");
    // Still only Wikimedia's own image servers, and only Commons' files on them.
    for (const thumbUrl of [
      "https://thumb.wikimedia.org.evil.example/wikipedia/commons/thumb/a/ab/P.jpg/960px-P.jpg",
      "https://evil.example/wikipedia/commons/thumb/a/ab/P.jpg/960px-P.jpg",
      "https://thumbs.wikimedia.org/wikipedia/commons/thumb/a/ab/P.jpg/960px-P.jpg",
      "https://thumb.wikimedia.org/wikipedia/en/thumb/a/ab/Local.jpg/960px-Local.jpg",
      "https://user@thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/P.jpg/960px-P.jpg",
    ]) expect(photoFrom(file({ LicenseShortName: "CC0" }, { thumbUrl }), "x", NOW), thumbUrl).toBeNull();
  });

  it("keeps a license link only on the license's own hosts", () => {
    expect(photoFrom(file({ LicenseShortName: "CC0", LicenseUrl: "https://evil.example/license" }), "x", NOW)?.licenseUrl).toBeNull();
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
    expect(photoFrom(file({ Artist: "&#1114112;", LicenseShortName: "CC BY 4.0", ImageDescription: "&#xD800; lawn" }), "osm:image", NOW)).toMatchObject({ author: "&#1114112;", alt: "&#xD800; lawn" });
  });

  it("reads text full of unclosed tags once, and only as far as it could be shown", () => {
    const started = performance.now();
    expect(plainText("<".repeat(200_000), 100)).toBe("<".repeat(99) + "…");
    expect(plainText("<p".repeat(100_000), 100)).toBe("<p".repeat(49) + "<…");
    expect(performance.now() - started).toBeLessThan(500);
    expect(plainText(`Jane${" ".repeat(30_000)}Doe`, 100)).toBe("Jane");
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
