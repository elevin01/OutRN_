"use client";

import { useState } from "react";
import type { ShownPhoto } from "../lib/categories";
import { CategoryIcon } from "./CategoryIcon";

/** A background tone for the icon card, by what kind of outing it is. */
function toneOf(category: string): string {
  if (/^(park|garden|waterfront|viewpoint)$/.test(category)) return "outdoors";
  if (/^(bar|nightclub)$/.test(category)) return "drink";
  if (/^(museum|gallery|arts_centre|attraction|library|bookshop|community)$/.test(category)) return "culture";
  if (/^(cinema|theatre|live_music|bowling|arcade|activity)$/.test(category)) return "entertainment";
  return "food";
}

/**
 * A place's photo with its credit, or a representative one labelled as such. When it fails to load
 * (or there is none), the category's icon: never a representative photo in place of the venue's own.
 */
export function PhotoFigure({ photo, category }: { photo: ShownPhoto | undefined; category: string }) {
  const [failed, setFailed] = useState<string[]>([]);
  const shown = photo && !failed.includes(photo.url) ? photo : undefined;
  const fail = (url: string) => setFailed((f) => (f.includes(url) ? f : [...f, url]));
  if (!shown)
    return (
      <div className="card-photo card-photo-empty" data-tone={toneOf(category)} aria-hidden="true">
        <CategoryIcon category={category} size={56} />
      </div>
    );
  return (
    <figure className="card-photo">
      {/* A plain img: photos come from Wikimedia's servers with their own sizes; no optimizer proxy. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={(img) => {
          // An error before hydration never reaches onError: check the element once React has it.
          if (img?.complete && img.naturalWidth === 0) fail(shown.url);
        }}
        src={shown.url}
        alt={shown.alt}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => fail(shown.url)}
      />
      <figcaption>
        {shown.kind === "representative" ? "Representative photo · not this place · " : "Photo: "}
        {shown.creditUrl ? (
          <a href={shown.creditUrl} target="_blank" rel="noopener noreferrer">
            {shown.credit}
          </a>
        ) : (
          shown.credit
        )}
      </figcaption>
    </figure>
  );
}
