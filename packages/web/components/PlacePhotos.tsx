"use client";

import { useState } from "react";
import { photosToShow, type ShownPhoto } from "../lib/categories";

/**
 * A place's photos with their credits, or representative ones labelled as such. When none of the
 * place's own loads, the representative ones; when none of those loads either (or there are none),
 * nothing: never the category's icon in place of a photo.
 */
export function PlacePhotos({ photos, fallback, max, className }: { photos: readonly ShownPhoto[]; fallback: readonly ShownPhoto[]; max?: number; className?: string }) {
  const [failed, setFailed] = useState<string[]>([]);
  const fail = (url: string) => setFailed((f) => (f.includes(url) ? f : [...f, url]));
  const shown = photosToShow(photos, fallback, failed).slice(0, max);
  if (!shown.length) return null;
  const figures = shown.map((p) => <PhotoFigure key={p.url} photo={p} onFail={fail} />);
  return className ? <div className={className}>{figures}</div> : <>{figures}</>;
}

function PhotoFigure({ photo, onFail }: { photo: ShownPhoto; onFail: (url: string) => void }) {
  return (
    <figure className="card-photo">
      {/* A plain img: photos come from Wikimedia's servers with their own sizes; no optimizer proxy. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={(img) => {
          // An error before hydration never reaches onError: check the element once React has it.
          if (img?.complete && img.naturalWidth === 0) onFail(photo.url);
        }}
        src={photo.url}
        alt={photo.alt}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => onFail(photo.url)}
      />
      <figcaption>
        {photo.kind === "representative" ? "Representative photo · not this place · " : "Photo: "}
        {photo.creditUrl ? (
          <a href={photo.creditUrl} target="_blank" rel="noopener noreferrer">
            {photo.credit}
          </a>
        ) : (
          photo.credit
        )}
      </figcaption>
    </figure>
  );
}
