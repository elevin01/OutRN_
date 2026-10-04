import Link from "next/link";
import type { AreasResponse, RecommendationRequest } from "@outrn/contracts";
import { ALL_ICON, groupOf, groupsFor } from "../lib/categories";
import { hrefForRequest } from "../lib/request";
import { CategoryIcon } from "./CategoryIcon";

/** One-click category shortcuts: the current search, narrowed to a few related kinds of place (or all). */
export function CategoryShortcuts({ meta, base }: { meta: AreasResponse; base: RecommendationRequest }) {
  const groups = groupsFor(meta);
  const active = groupOf(groups, base.categories);
  const { categories: _current, ...rest } = base;
  const everything = !base.categories?.length;
  return (
    <nav className="category-shortcuts" aria-label="Kinds of place">
      <Link className={everything ? "shortcut active" : "shortcut"} aria-current={everything ? "page" : undefined} href={hrefForRequest(rest, meta)}>
        <CategoryIcon path={ALL_ICON} />
        All
      </Link>
      {groups.map((g) => (
        <Link key={g.id} className={active?.id === g.id ? "shortcut active" : "shortcut"} aria-current={active?.id === g.id ? "page" : undefined} href={hrefForRequest({ ...rest, categories: g.categories }, meta)}>
          <CategoryIcon path={g.icon} />
          {g.label}
        </Link>
      ))}
    </nav>
  );
}
