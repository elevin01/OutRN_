import { describe, expect, it } from "vitest";
import { commonsFiles, commonsImageInfoUrl, commonsTitleFrom, DELETION_TEMPLATES, replayWikimediaFetcher, WIKIMEDIA_BATCH, wikidataClaimsUrl, wikidataImages, type JsonFetcher } from "./wikimedia.js";

/** A fetcher that answers from a map and records every URL asked. */
function fake(answers: (url: string) => unknown): JsonFetcher & { asked: string[] } {
  const asked: string[] = [];
  return { asked, get: async (url) => (asked.push(url), answers(url)) };
}

describe("which Commons file a tag or link names", () => {
  it("reads the wikimedia_commons tag, Commons file pages, and upload.wikimedia.org originals and thumbnails", () => {
    expect(commonsTitleFrom("File:Tenement Museum.jpg")).toBe("File:Tenement Museum.jpg");
    expect(commonsTitleFrom("Image:Old_Name.jpg")).toBe("File:Old Name.jpg");
    expect(commonsTitleFrom("https://commons.wikimedia.org/wiki/File:Pitt_Park%2C_2019.jpg")).toBe("File:Pitt Park, 2019.jpg");
    expect(commonsTitleFrom("https://upload.wikimedia.org/wikipedia/commons/a/ab/Pitt_Park.jpg")).toBe("File:Pitt Park.jpg");
    expect(commonsTitleFrom("https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Pitt_Park.jpg/800px-Pitt_Park.jpg")).toBe("File:Pitt Park.jpg");
  });

  it("names nothing for other hosts, categories, bad escapes or titles MediaWiki would refuse", () => {
    for (const ref of ["https://example.com/photo.jpg", "https://upload.wikimedia.org/wikipedia/en/a/ab/Local.jpg", "Category:Pitt Park", "https://commons.wikimedia.org/wiki/Category:Pitt_Park", "File:%E0%A4%A.jpg", "File:a|b.jpg", "File:", "javascript:alert(1)", ""]) {
      expect(commonsTitleFrom(ref), ref).toBeNull();
    }
  });
});

describe("Wikidata images (P18)", () => {
  it("takes the preferred image first, drops deprecated ones, and asks only for well-formed ids, in sorted batches", async () => {
    const f = fake(() => ({
      entities: {
        Q2: { claims: { P18: [{ rank: "normal", mainsnak: { datavalue: { value: "B.jpg" } } }, { rank: "deprecated", mainsnak: { datavalue: { value: "Old.jpg" } } }, { rank: "preferred", mainsnak: { datavalue: { value: "A.jpg" } } }] } },
        // A value that would split a batched Commons request, or can't be a title: dropped, by the rule tags go through.
        Q3: { claims: { P18: [{ rank: "normal", mainsnak: { datavalue: { value: "X.jpg|File:Other.jpg" } } }, { rank: "normal", mainsnak: { datavalue: { value: "Y\n.jpg" } } }, { rank: "normal", mainsnak: { datavalue: { value: "Pitt_Park.jpg" } } }] } },
        Q10: { claims: {} },
      },
    }));
    const images = await wikidataImages(f, ["Q2", "Q10", "Q2", "not-an-id", "Q0", "Q3"]);
    expect(f.asked).toEqual([wikidataClaimsUrl(["Q10", "Q2", "Q3"])]);
    expect([...images]).toEqual([["Q2", ["File:A.jpg", "File:B.jpg"]], ["Q3", ["File:Pitt Park.jpg"]]]);
  });

  it(`asks for at most ${WIKIMEDIA_BATCH} ids at a time`, async () => {
    const f = fake(() => ({ entities: {} }));
    await wikidataImages(f, Array.from({ length: WIKIMEDIA_BATCH + 1 }, (_, i) => `Q${i + 1}`));
    expect(f.asked).toHaveLength(2);
  });
});

describe("Commons file metadata", () => {
  it("maps Commons' normalized titles back to the ones asked for, and skips missing files", async () => {
    const f = fake(() => ({
      query: {
        normalized: [{ from: "File:pitt Park.jpg", to: "File:Pitt Park.jpg" }],
        pages: [
          { title: "File:Pitt Park.jpg", imageinfo: [{ timestamp: "2019-05-04T12:00:00Z", mime: "image/jpeg", thumburl: "https://upload.wikimedia.org/t.jpg", thumbwidth: 800, thumbheight: 600, descriptionurl: "https://commons.wikimedia.org/wiki/File:Pitt_Park.jpg", extmetadata: { LicenseShortName: { value: "CC0" } } }] },
          { title: "File:Gone.jpg", missing: true },
        ],
      },
    }));
    const files = await commonsFiles(f, ["File:pitt Park.jpg", "File:Gone.jpg"]);
    expect(f.asked).toEqual([commonsImageInfoUrl(["File:Gone.jpg", "File:pitt Park.jpg"])]);
    expect([...files.keys()]).toEqual(["File:pitt Park.jpg"]);
    expect(files.get("File:pitt Park.jpg")).toMatchObject({ title: "File:Pitt Park.jpg", thumbWidth: 800, uploadedAt: "2019-05-04T12:00:00Z", deletionTags: [], meta: { LicenseShortName: "CC0" } });
  });

  it("asks for the upload time and the deletion tags alongside the metadata, and reads them", async () => {
    const url = new URL(commonsImageInfoUrl(["File:A.jpg"]));
    expect(url.searchParams.get("prop")).toBe("imageinfo|templates");
    expect(url.searchParams.get("iiprop")?.split("|")).toContain("timestamp");
    expect(url.searchParams.get("tltemplates")).toBe(DELETION_TEMPLATES.join("|"));
    const info = { mime: "image/jpeg", thumburl: "https://upload.wikimedia.org/t.jpg", thumbwidth: 800, thumbheight: 600, descriptionurl: "https://commons.wikimedia.org/wiki/File:A.jpg" };
    const answer = (extra: object) => fake(() => ({ query: { pages: [{ title: "File:A.jpg", templates: [{ ns: 10, title: "Template:Delete" }], imageinfo: [{ ...info, timestamp: 20190504 }] }, { title: "File:B.jpg", imageinfo: [info] }] }, ...extra }));
    const files = await commonsFiles(answer({}), ["File:A.jpg", "File:B.jpg"]);
    expect(files.get("File:A.jpg")).toMatchObject({ uploadedAt: null, deletionTags: ["Template:Delete"] });
    expect(files.get("File:B.jpg")).toMatchObject({ uploadedAt: null, deletionTags: [] });
    // An answer Commons cut short in the tags may be missing a file's: every file in it counts as tagged.
    const cut = await commonsFiles(answer({ continue: { tlcontinue: "123|10|Delete", continue: "||imageinfo" } }), ["File:A.jpg", "File:B.jpg"]);
    expect(cut.get("File:B.jpg")?.deletionTags).not.toEqual([]);
    // Older versions of a lone file continue imageinfo, not the tags: nothing is missing.
    const older = await commonsFiles(answer({ continue: { iistart: "2019-05-04T12:00:00Z", continue: "||templates" } }), ["File:A.jpg", "File:B.jpg"]);
    expect(older.get("File:B.jpg")?.deletionTags).toEqual([]);
  });

  it("a replay answers only what was recorded", async () => {
    const url = wikidataClaimsUrl(["Q1"]);
    const replay = replayWikimediaFetcher({ outrn_capture: "wikimedia", responses: { [url]: { entities: {} } } });
    await expect(replay.get(url)).resolves.toEqual({ entities: {} });
    await expect(replay.get(wikidataClaimsUrl(["Q2"]))).rejects.toThrow(/record it again with --save/);
  });
});
