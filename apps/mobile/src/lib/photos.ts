import type { Photo } from "@outrn/contracts";

/**
 * What the photo area shows, in order: the place's own photos (from the API, each with the credit its
 * license requires); when it has none, representative photos of the kind of place, labelled as such
 * so they are never taken for the place itself; when there are none of those either, the artwork.
 */
export interface ShownPhoto<Source = unknown> {
  source: Source;
  kind: "place" | "representative";
  /** Credit to show with the photo ("Jane Doe, CC BY-SA 4.0", "Unsplash"). */
  credit: string;
  /** Where the credit links: the file's page on Commons, or the photo's page. */
  creditUrl: string | null;
  /** What a screen reader says. */
  alt: string;
}

export interface RepresentativePhoto<Source = unknown> {
  source: Source;
  credit: string;
  url: string;
}

export function photosFor<Source>(
  placeName: string,
  categoryLabel: string,
  photos: readonly Photo[] | undefined,
  representative: readonly RepresentativePhoto<Source>[],
  remote: (url: string) => Source,
): ShownPhoto<Source>[] {
  if (photos?.length)
    return photos.map((p, i) => ({
      source: remote(p.url),
      kind: "place",
      credit: p.credit,
      creditUrl: p.sourceUrl,
      alt: p.alt ? `${placeName}: ${p.alt}` : `Photo ${i + 1} of ${placeName}`,
    }));
  const kind = categoryLabel.toLowerCase();
  return representative.map((r) => ({
    source: r.source,
    kind: "representative",
    credit: r.credit,
    creditUrl: r.url,
    alt: `A representative photo of a ${kind}, not ${placeName}`,
  }));
}
