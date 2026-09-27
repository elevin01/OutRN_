import type { AreasResponse } from "@outrn/contracts";
import type { FormValues } from "../lib/request";

interface Props {
  meta: AreasResponse;
  defaults?: FormValues;
  ops?: boolean;
}

/** Every option comes from GET /v1/areas, so a category or mood the backend adds shows up here. */
export function SearchForm({ meta, defaults = {}, ops = false }: Props) {
  const { filters } = meta;
  return (
    <form className={ops ? "search-form ops-form" : "search-form"} method="get">
      <input type="hidden" name="run" value="1" />
      <label>
        <span>Neighborhood</span>
        <select name="area" defaultValue={defaults["area"] ?? meta.defaultAreaId}>
          {meta.areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}
        </select>
      </label>
      <label>
        <span>Time free</span>
        <select name="minutes" defaultValue={defaults["minutes"] ?? String(filters.defaultWindowMinutes)}>
          {filters.windows.map((w) => <option key={w.minutes} value={w.minutes}>{w.label}</option>)}
        </select>
      </label>
      <label>
        <span>Getting there</span>
        <select name="mode" defaultValue={defaults["mode"] ?? ""}>
          {/* Empty = the area's own travel mode (drive in Bronxville, walk on the LES), resolved by the API. */}
          <option value="">Area default</option>
          {filters.travelModes.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </label>
      <label>
        <span>Budget</span>
        <select name="budget" defaultValue={defaults["budget"] ?? "any"}>
          {filters.budgets.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
        </select>
      </label>
      <label>
        <span>Mood</span>
        <select name="mood" defaultValue={defaults["mood"] ?? ""}>
          <option value="">Any mood</option>
          {filters.moods.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </label>
      <label>
        <span>Category</span>
        <select name="category" defaultValue={defaults["category"] ?? ""}>
          <option value="">Surprise me</option>
          {filters.categories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
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
