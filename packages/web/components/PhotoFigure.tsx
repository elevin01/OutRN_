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
 * (or there is none), the fallback, then the category's icon.
 */
export function PhotoFigure({ photo, fallback, category }: { photo: ShownPhoto | undefined; fallback?: ShownPhoto | undefined; category: string }) {
  const [failed, setFailed] = useState<string[]>([]);
  const shown = [photo, fallback].find((p): p is ShownPhoto => !!p && !failed.includes(p.url));
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
      <img src={shown.url} alt={shown.alt} loading="lazy" onError={() => setFailed((f) => [...f, shown.url])} />
      <figcaption>
        {shown.kind === "representative" ? "Representative photo · not this place · " : "Photo: "}
        {shown.creditUrl ? (
          <a href={shown.creditUrl} target="_blank" rel="noreferrer">
            {shown.credit}
          </a>
        ) : (
          shown.credit
        )}
      </figcaption>
    </figure>
  );
}
