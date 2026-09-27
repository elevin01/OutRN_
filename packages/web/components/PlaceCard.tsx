import Link from "next/link";
import type { Evaluation } from "@outrn/engine";
import type { CardCopy } from "@outrn/engine";

interface Props {
  evaluation: Evaluation;
  copy: CardCopy;
  index: number;
}

function categoryLabel(value: string): string {
  return value.replaceAll("_", " ");
}

export function mapsUrl(evaluation: Evaluation): string {
  const { lat, lon } = evaluation.candidate.point;
  const mode = evaluation.timing?.travel.mode;
  const travelMode = mode === "drive" ? "driving" : mode === "transit" ? "transit" : "walking";
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${lat},${lon}`)}&travelmode=${travelMode}`;
}

export function PlaceCard({ evaluation, copy, index }: Props) {
  const item = evaluation.candidate;
  return (
    <article className="place-card">
      <div className="card-topline">
        <span className="card-number">{String(index + 1).padStart(2, "0")}</span>
        <span className={`status-pill ${evaluation.class}`}>{copy.cta}</span>
      </div>
      <div>
        <p className="eyebrow">{categoryLabel(item.category)}</p>
        <h2>{item.name}</h2>
        <p className="fact-line">{copy.factLine}</p>
        {copy.sentence && <p className="reason-line">{copy.sentence}</p>}
        {copy.caveat && <p className="caveat">{copy.caveat}</p>}
      </div>
      <div className="card-actions">
        <Link className="text-button" href={`/places/${item.venueId}${evaluation.timing ? `?mode=${evaluation.timing.travel.mode}` : ""}`}>Details</Link>
        <a className="map-button" href={mapsUrl(evaluation)} target="_blank" rel="noreferrer">Open in Maps <span aria-hidden="true">↗</span></a>
      </div>
    </article>
  );
}
