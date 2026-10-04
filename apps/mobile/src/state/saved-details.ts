import { useEffect, useRef, useState } from "react";
import type { PlaceDetails } from "@outrn/contracts";
import { api } from "../lib/api";

/** Fetch visible tiles/covers only, with a short memory cache and bounded concurrency. */
export function useSavedDetails(
  ids: string[],
  refresh: number,
  focused: boolean,
) {
  const [details, setDetails] = useState<Record<string, PlaceDetails>>({});
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const cache = useRef(new Map<string, { at: number; revision: number }>());
  const key = JSON.stringify(ids);
  useEffect(() => {
    if (!focused) return;
    const controller = new AbortController();
    const queue = (JSON.parse(key) as string[]).filter((id) => {
      const loaded = cache.current.get(id);
      return (
        !loaded ||
        loaded.revision !== refresh ||
        Date.now() - loaded.at > 60_000
      );
    });
    const worker = async () => {
      while (queue.length && !controller.signal.aborted) {
        const id = queue.shift()!;
        try {
          const place = await api.place(id, controller.signal);
          if (place.id !== id) throw new Error("Place identity changed");
          if (!controller.signal.aborted) {
            cache.current.set(id, { at: Date.now(), revision: refresh });
            setDetails((old) => ({ ...old, [id]: place }));
            setFailed(
              (old) => new Set([...old].filter((failedId) => failedId !== id)),
            );
          }
        } catch {
          if (!controller.signal.aborted)
            setFailed((old) => new Set([...old, id]));
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
    return () => controller.abort();
  }, [key, refresh, focused]);
  return { details, failed };
}
