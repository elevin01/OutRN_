import Link from "next/link";
import type { RecommendationItem } from "@outrn/contracts";
import { photosFor, representativeFor } from "../lib/categories";
import { cardTags } from "../lib/card";
import { CategoryIcon } from "./CategoryIcon";
import { PlacePhotos } from "./PlacePhotos";

interface Props {
  item: RecommendationItem;
  index: number;
}

export function PlaceCard({ item, index }: Props) {
  const tags = cardTags(item);
  return (
    <article className="place-card">
      <PlacePhotos photos={photosFor(item.name, item.category, item.photos)} fallback={representativeFor(item.name, item.category)} max={1} />
      <div className="card-topline">
        <span className="card-number">{String(index + 1).padStart(2, "0")}</span>
        <span className={`status-pill ${item.status}`}>{item.copy.action}</span>
      </div>
      <div>
        <p className="eyebrow category-line"><CategoryIcon category={item.category.id} size={14} />{item.category.label}</p>
        <h2>{item.name}</h2>
        <p className="fact-line">{item.copy.summary}</p>
        {tags.length > 0 && (
          <ul className="tag-list" aria-label="What it offers">
            {tags.map((t) => <li key={t}>{t}</li>)}
          </ul>
        )}
        {item.conditions.length > 0 && (
          <ul className="condition-list" aria-label="What to expect">
            {item.conditions.map((c, i) => <li key={`${c.kind}-${i}`} className={`condition ${c.kind}`}>{c.text}</li>)}
          </ul>
        )}
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
