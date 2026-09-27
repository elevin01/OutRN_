export type Search = Record<string, string | string[] | undefined>;

export function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function integer(value: string | string[] | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(one(value) ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}
