import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  LEGACY_SAVED_KEY,
  SAVED_KEY,
  putCollection,
  readSavedLibrary,
  restorePlace,
  togglePlace,
  type RemovedSave,
  type SavedCollection,
  type SavedLibrary,
  type SavedPlace,
} from "../lib/saved-library";

export function useSavedLibrary() {
  const [library, setLibrary] = useState<SavedLibrary>({
    places: [],
    collections: [],
  });
  const [hydrated, setHydrated] = useState(false);
  const [storageError, setStorageError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const writes = useRef(Promise.resolve());
  const mounted = useRef(false);
  const load = useCallback(
    () =>
      AsyncStorage.getItem(SAVED_KEY)
        .then(async (raw) =>
          readSavedLibrary(
            raw,
            raw === null ? await AsyncStorage.getItem(LEGACY_SAVED_KEY) : null,
          ),
        )
        .then((next) => {
          if (mounted.current) {
            setStorageError(undefined);
            setLibrary(next);
            setHydrated(true);
          }
        })
        .catch(() => {
          if (mounted.current)
            setStorageError(
              "Saved places couldn’t be loaded on this device. Try again to keep your existing saves safe.",
            );
        }),
    [],
  );
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);
  useEffect(() => {
    if (!hydrated || revision === 0) return;
    writes.current = writes.current
      .then(() => AsyncStorage.setItem(SAVED_KEY, JSON.stringify(library)))
      .then(() => {
        if (mounted.current) setStorageError(undefined);
      })
      .catch(() => {
        if (mounted.current)
          setStorageError(
            "Your changes couldn’t be saved on this device. Try again before closing the app.",
          );
      });
  }, [library, hydrated, revision]);
  const change = (update: (old: SavedLibrary) => SavedLibrary) => {
    if (!hydrated) return;
    setLibrary(update);
    setRevision((n) => n + 1);
  };
  return {
    saved: library.places,
    collections: library.collections,
    hydrated,
    storageError,
    retrySaved: () => (hydrated ? setRevision((n) => n + 1) : void load()),
    toggleSaved: (place: SavedPlace) =>
      change((old) => togglePlace(old, place)),
    restoreSaved: (removed: RemovedSave) =>
      change((old) => restorePlace(old, removed)),
    saveCollection: (collection: SavedCollection) =>
      change((old) => putCollection(old, collection)),
    deleteCollection: (id: string) =>
      change((old) => ({
        ...old,
        collections: old.collections.filter((c) => c.id !== id),
      })),
  };
}
