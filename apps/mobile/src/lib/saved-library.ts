export type SavedPlace = { id: string; name: string; category: string };
export type SavedCollection = { id: string; name: string; placeIds: string[] };
export type SavedLibrary = {
  places: SavedPlace[];
  collections: SavedCollection[];
};
export type RemovedSave = {
  place: SavedPlace;
  index: number;
  collectionIds: string[];
};
export const SAVED_KEY = "outrn.saved.v2";
export const LEGACY_SAVED_KEY = "outrn.saved.v1";
export const MAX_SAVED = 200;
export const MAX_COLLECTIONS = 50;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** Read the old identity-only saves without writing until the user makes a change. */
export function readSavedLibrary(
  raw: string | null,
  legacy: string | null,
): SavedLibrary {
  const data: unknown = JSON.parse(raw ?? legacy ?? "[]");
  const source = raw === null ? { places: data, collections: [] } : data;
  if (
    !record(source) ||
    !Array.isArray(source.places) ||
    !Array.isArray(source.collections)
  )
    throw new Error("Unreadable saved library");
  const places: SavedPlace[] = [];
  const ids = new Set<string>();
  for (const p of source.places) {
    if (
      record(p) &&
      nonempty(p.id) &&
      nonempty(p.name) &&
      nonempty(p.category) &&
      !ids.has(p.id)
    ) {
      places.push({ id: p.id, name: p.name, category: p.category });
      ids.add(p.id);
      if (places.length === MAX_SAVED) break;
    }
  }
  const collections: SavedCollection[] = [];
  for (const c of source.collections) {
    if (
      record(c) &&
      nonempty(c.id) &&
      nonempty(c.name) &&
      Array.isArray(c.placeIds) &&
      !collections.some((x) => x.id === c.id)
    ) {
      collections.push({
        id: c.id,
        name: c.name.trim().slice(0, 40),
        placeIds: [
          ...new Set(
            c.placeIds.filter(
              (id): id is string => typeof id === "string" && ids.has(id),
            ),
          ),
        ],
      });
      if (collections.length === MAX_COLLECTIONS) break;
    }
  }
  return { places, collections };
}

export function togglePlace(
  library: SavedLibrary,
  place: SavedPlace,
): SavedLibrary {
  const places = library.places.some((p) => p.id === place.id)
    ? library.places.filter((p) => p.id !== place.id)
    : [place, ...library.places].slice(0, MAX_SAVED);
  const ids = new Set(places.map((p) => p.id));
  return {
    places,
    collections: library.collections.map((c) => ({
      ...c,
      placeIds: c.placeIds.filter((id) => ids.has(id)),
    })),
  };
}

export function restorePlace(
  library: SavedLibrary,
  removed: RemovedSave,
): SavedLibrary {
  const places = library.places.filter((p) => p.id !== removed.place.id);
  places.splice(Math.min(removed.index, places.length), 0, removed.place);
  const kept = places.slice(0, MAX_SAVED);
  const ids = new Set(kept.map((p) => p.id));
  return {
    places: kept,
    collections: library.collections.map((c) => ({
      ...c,
      placeIds: [
        ...new Set([
          ...c.placeIds,
          ...(removed.collectionIds.includes(c.id) ? [removed.place.id] : []),
        ]),
      ].filter((id) => ids.has(id)),
    })),
  };
}

export function putCollection(
  library: SavedLibrary,
  collection: SavedCollection,
): SavedLibrary {
  const existing = library.collections.some((c) => c.id === collection.id);
  if (
    !collection.name.trim() ||
    (!existing && library.collections.length >= MAX_COLLECTIONS)
  )
    return library;
  const next = {
    id: collection.id,
    name: collection.name.trim().slice(0, 40),
    placeIds: [...new Set(collection.placeIds)].filter((id) =>
      library.places.some((p) => p.id === id),
    ),
  };
  return {
    ...library,
    collections: existing
      ? library.collections.map((c) => (c.id === next.id ? next : c))
      : [...library.collections, next],
  };
}
