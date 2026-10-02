import { describe, expect, it } from "vitest";
import { areas } from "@outrn/contracts/fixtures";
import { categoryIconPath, groupOf, groupsFor, photosFor, photosToShow, representativeFor } from "./categories";
import { formFromResolved, hrefForRequest, requestFromQuery } from "./request";

describe("category shortcuts on the web", () => {
  it("narrow a search to several kinds through the URL, and back", () => {
    const groups = groupsFor(areas);
    const outdoors = groups.find((g) => g.id === "outdoors")!;
    expect(outdoors.categories.length).toBeGreaterThan(1);
    const href = hrefForRequest({ areaId: "les", windowMinutes: 120, categories: outdoors.categories }, areas);
    const query = Object.fromEntries(new URL(href, "https://x.example").searchParams);
    expect(query["categories"]).toBe(outdoors.categories.join(","));
    expect(requestFromQuery(query, areas).categories).toEqual(outdoors.categories);
    expect(groupOf(groups, outdoors.categories)?.id).toBe("outdoors");
    // One kind still travels as the form's single category.
    expect(Object.fromEntries(new URL(hrefForRequest({ areaId: "les", windowMinutes: 120, categories: ["cafe"] }, areas), "https://x.example").searchParams)["category"]).toBe("cafe");
  });

  it("drop kinds the area doesn't offer, and keep within the limit", () => {
    const r = requestFromQuery({ area: "les", categories: "park,not-a-kind,__proto__,garden,waterfront,viewpoint,museum,gallery" }, areas);
    expect(r.categories).toEqual(["park", "garden", "waterfront", "viewpoint", "museum"].slice(0, areas.limits.maxCategories));
  });

  it("give every kind an icon, and anything unknown a map pin", () => {
    for (const c of areas.filters.categories) expect(categoryIconPath(c.id), c.id).not.toBe(categoryIconPath("unknown"));
    expect(categoryIconPath("__proto__")).toBe(categoryIconPath("unknown"));
  });

  it("show the place's own photos with their credit, else a labelled representative one", () => {
    const own = photosFor("Pitt Park", { id: "park", label: "Park" }, [{ url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/3/3f/A.jpg/960px-A.jpg", width: 960, height: 720, alt: "The lawn", credit: "Jane Doe, CC BY-SA 4.0", author: "Jane Doe", license: "CC BY-SA 4.0", licenseUrl: null, sourceUrl: "https://commons.wikimedia.org/wiki/File:A.jpg" }]);
    expect(own).toEqual([{ url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/3/3f/A.jpg/960px-A.jpg", kind: "place", credit: "Jane Doe, CC BY-SA 4.0", creditUrl: "https://commons.wikimedia.org/wiki/File:A.jpg", alt: "Pitt Park: The lawn" }]);
    expect(photosFor("Rex", { id: "cafe", label: "Cafe" }, [])[0]).toMatchObject({ kind: "representative", url: "/representative/cafe.jpg", credit: "Unsplash", alt: "A representative photo of a cafe, not Rex" });
    expect(photosFor("Seward Park", { id: "park", label: "Park" }, [])).toEqual([]);
  });

  it("when none of the place's own loads, a labelled representative one; when none of those loads, nothing", () => {
    const cafe = { id: "cafe", label: "Cafe" };
    const own = photosFor("Rex", cafe, [{ url: "https://upload.wikimedia.org/wikipedia/commons/a.jpg", width: 960, height: 720, alt: null, credit: "Jane Doe, CC BY-SA 4.0", author: "Jane Doe", license: "CC BY-SA 4.0", licenseUrl: null, sourceUrl: "https://commons.wikimedia.org/wiki/File:A.jpg" }]);
    const fallback = representativeFor("Rex", cafe);
    expect(photosToShow(own, fallback, [])).toEqual(own);
    expect(photosToShow(own, fallback, [own[0]!.url])).toEqual(fallback);
    expect(photosToShow(own, fallback, [own[0]!.url])[0]).toMatchObject({ kind: "representative", alt: "A representative photo of a cafe, not Rex" });
    expect(photosToShow(own, fallback, [own[0]!.url, ...fallback.map((p) => p.url)])).toEqual([]);
    // A kind without representative photos: nothing, never a stand-in.
    expect(representativeFor("Seward Park", { id: "park", label: "Park" })).toEqual([]);
    expect(photosToShow(own, representativeFor("Rex", { id: "park", label: "Park" }), [own[0]!.url])).toEqual([]);
    // Same lookup as the shortcuts: no inherited keys.
    expect(representativeFor("Rex", { id: "__proto__", label: "Thing" })).toEqual([]);
  });

  it("load only https photos on Wikimedia's image hosts, and link the credit only over https", () => {
    const photo = (over: Record<string, string>) => ({ url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/3/3f/A.jpg/960px-A.jpg", width: 960, height: 720, alt: null, credit: "Jane Doe, CC BY-SA 4.0", author: "Jane Doe", license: "CC BY-SA 4.0", licenseUrl: null, sourceUrl: "https://commons.wikimedia.org/wiki/File:A.jpg", ...over });
    const cafe = { id: "cafe", label: "Cafe" };
    for (const url of ["http://thumb.wikimedia.org/wikipedia/commons/a.jpg", "https://tracker.example/pixel.gif", "file:///etc/hosts", "data:image/png;base64,AAAA", "https://user:pw@upload.wikimedia.org/wikipedia/commons/a.jpg", "https://upload.wikimedia.org.evil.example/a.jpg"]) {
      const kinds = photosFor("Rex", cafe, [photo({ url })]).map((p) => p.kind);
      expect(kinds.length, url).toBeGreaterThan(0);
      expect(kinds.every((k) => k === "representative"), url).toBe(true);
    }
    for (const sourceUrl of ["javascript:alert(1)", "http://commons.wikimedia.org/wiki/File:A.jpg", "data:text/html,hi"]) {
      expect(photosFor("Rex", cafe, [photo({ sourceUrl })])[0], sourceUrl).toMatchObject({ kind: "place", creditUrl: null });
    }
    expect(photosFor("Rex", { id: "arts_centre", label: "Arts centre" }, [])[0]?.alt).toBe("A representative photo of an arts centre, not Rex");
  });

  it("carry a shortcut's kinds back to the page from a resolved search", () => {
    // Only the fields the form reads.
    const resolved = { areaId: "les", windowMinutes: 120, travelMode: "walk", travelModeIsDefault: true, budget: { kind: "any" }, mood: null, company: null, categories: ["cinema", "theatre"], cuisines: [], diets: [], features: [], youngestAge: null, at: "2026-10-02T23:00:00Z", atIsExplicit: false };
    const form = formFromResolved(resolved as unknown as Parameters<typeof formFromResolved>[0], areas);
    expect(form["categories"]).toBe("cinema,theatre");
    expect(form["category"]).toBe("");
  });
});
