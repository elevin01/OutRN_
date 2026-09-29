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

/** Where the API's photos live: Wikimedia's image hosts, nowhere else. */
const PHOTO_HOSTS = /^(upload|thumb)\.wikimedia\.org$/;

/** An https address without credentials (optionally on one of `hosts`), else null. */
export function safeHttpsUrl(value: string | null | undefined, hosts?: RegExp): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && (!hosts || hosts.test(u.hostname)) ? u.toString() : null;
  } catch {
    return null;
  }
}

/** "a café", "an arts centre". */
const withArticle = (kind: string) => `${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind}`;

export function photosFor<Source>(
  placeName: string,
  categoryLabel: string,
  photos: readonly Photo[] | undefined,
  representative: readonly RepresentativePhoto<Source>[],
  remote: (url: string) => Source,
): ShownPhoto<Source>[] {
  // The payload is not trusted: only https images on Wikimedia's hosts load, and a credit links only
  // over https. A photo that fails the check is dropped; a credit that does is shown as plain text.
  const own = (photos ?? []).flatMap((p, i): ShownPhoto<Source>[] => {
    const url = safeHttpsUrl(p.url, PHOTO_HOSTS);
    return url
      ? [
          {
            source: remote(url),
            kind: "place",
            credit: p.credit,
            creditUrl: safeHttpsUrl(p.sourceUrl),
            alt: p.alt ? `${placeName}: ${p.alt}` : `Photo ${i + 1} of ${placeName}`,
          },
        ]
      : [];
  });
  if (own.length) return own;
  const kind = categoryLabel.toLowerCase();
  return representative.map((r) => ({
    source: r.source,
    kind: "representative",
    credit: r.credit,
    creditUrl: r.url,
    alt: `A representative photo of ${withArticle(kind)}, not ${placeName}`,
  }));
}
