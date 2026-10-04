import { categoryIconPath } from "../lib/categories";

/** A category's icon, decorative: the label beside it says what it is. */
export function CategoryIcon({ category, path, size = 18 }: { category?: string; path?: string; size?: number }) {
  return (
    <svg className="category-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={path ?? categoryIconPath(category ?? "")} fill="currentColor" />
    </svg>
  );
}
