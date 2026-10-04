export type Search = Record<string, string | string[] | undefined>;

export function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Every value of a parameter, whether repeated (checkboxes: `diets=vegan&diets=halal`) or comma-joined (`diets=vegan,halal`). */
export function many(value: string | string[] | undefined): string[] {
  return (Array.isArray(value) ? value : value === undefined ? [] : [value]).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
}

export function integer(value: string | string[] | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(one(value) ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}
