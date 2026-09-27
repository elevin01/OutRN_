import type { ServiceAreaRow } from "@outrn/db";
import { CATEGORIES } from "@outrn/core";

interface Props {
  areas: ServiceAreaRow[];
  defaults?: Record<string, string | undefined>;
  ops?: boolean;
}

function label(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function SearchForm({ areas, defaults = {}, ops = false }: Props) {
  return (
    <form className={ops ? "search-form ops-form" : "search-form"} method="get">
      <input type="hidden" name="run" value="1" />
      <label>
        <span>Neighborhood</span>
        <select name="area" defaultValue={defaults["area"] ?? "les"}>
          {areas.map((area) => <option key={area.slug} value={area.slug}>{area.name}</option>)}
        </select>
      </label>
      <label>
        <span>Time free</span>
        <select name="minutes" defaultValue={defaults["minutes"] ?? "180"}>
          <option value="60">1 hour</option>
          <option value="120">2 hours</option>
          <option value="180">3 hours</option>
          <option value="240">4 hours</option>
        </select>
      </label>
      <label>
        <span>Getting there</span>
        <select name="mode" defaultValue={defaults["mode"] ?? ""}>
          {/* Empty = the area's own travel mode (drive in Bronxville, walk on the LES), resolved server-side. */}
          <option value="">Area default</option>
          <option value="walk">Walk</option>
          <option value="transit">Transit</option>
          <option value="drive">Drive</option>
        </select>
      </label>
      <label>
        <span>Budget</span>
        <select name="budget" defaultValue={defaults["budget"] ?? "any"}>
          <option value="any">Any</option>
          <option value="free">Free</option>
          <option value="25">Up to $25</option>
          <option value="50">Up to $50</option>
        </select>
      </label>
      <label>
        <span>Mood</span>
        <select name="mood" defaultValue={defaults["mood"] ?? ""}>
          <option value="">Any mood</option>
          <option value="relaxed">Relaxed</option>
          <option value="active">Active</option>
          <option value="food">Food</option>
          <option value="culture">Culture</option>
        </select>
      </label>
      <label>
        <span>Category</span>
        <select name="category" defaultValue={defaults["category"] ?? ""}>
          <option value="">Surprise me</option>
          {CATEGORIES.filter((category) => category !== "other").map((category) => (
            <option key={category} value={category}>{label(category)}</option>
          ))}
        </select>
      </label>
      {ops && (
        <label className="wide-field">
          <span>Evaluate at (ISO, blank means now)</span>
          <input name="at" defaultValue={defaults["at"] ?? ""} placeholder="2026-10-03T22:30:00Z" />
        </label>
      )}
      <button className="primary-button" type="submit">{ops ? "Evaluate candidates" : "Show me three"}<span aria-hidden="true">→</span></button>
    </form>
  );
}
