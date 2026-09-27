import Link from "next/link";
import type { RecommendationItem } from "@outrn/contracts";

interface Props {
  item: RecommendationItem;
  index: number;
}

export function PlaceCard({ item, index }: Props) {
  return (
    <article className="place-card">
      <div className="card-topline">
        <span className="card-number">{String(index + 1).padStart(2, "0")}</span>
        <span className={`status-pill ${item.status}`}>{item.copy.action}</span>
      </div>
      <div>
        <p className="eyebrow">{item.category.label}</p>
        <h2>{item.name}</h2>
        <p className="fact-line">{item.copy.summary}</p>
        {item.copy.sentence && <p className="reason-line">{item.copy.sentence}</p>}
        {item.copy.caveat && <p className="caveat">{item.copy.caveat}</p>}
      </div>
      <div className="card-actions">
        <Link className="text-button" href={`/places/${item.placeId}?mode=${item.timing.travel.mode}`}>Details</Link>
        <a className="map-button" href={item.actions.directionsUrl} target="_blank" rel="noreferrer">Open in Maps <span aria-hidden="true">↗</span></a>
      </div>
    </article>
  );
}
