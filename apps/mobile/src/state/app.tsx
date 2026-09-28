import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  AreasResponse,
  RecommendationItem,
  RecommendationRequest,
  RecommendationResponse,
  RecommendationsBody,
} from "@outrn/contracts";
import { api, RequestError } from "../lib/api";
export type SavedPlace = { id: string; name: string; category: string };
export type Outing = {
  item: RecommendationItem;
  timezone: string;
  expiresAt: string;
  arrived: boolean;
};
const KEY = "outrn.saved.v1";
function useAppState() {
  const [areas, setAreas] = useState<AreasResponse>();
  const [query, setQuery] = useState<RecommendationRequest>();
  const [result, setResult] = useState<RecommendationResponse>();
  const [error, setError] = useState<RequestError>();
  const [busy, setBusy] = useState(true);
  const [saved, setSaved] = useState<SavedPlace[]>([]);
  const [storageError, setStorageError] = useState<string>();
  const [hydrated, setHydrated] = useState(false);
  const [outing, setOuting] = useState<Outing>();
  const searchController = useRef<AbortController | null>(null);
  const loadController = useRef<AbortController | null>(null);
  const writes = useRef(Promise.resolve());
  const savedLoaded = useRef(false);
  const [saveRevision, setSaveRevision] = useState(0);
  async function search(
    body: RecommendationsBody,
    nextQuery?: RecommendationRequest,
  ) {
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    if (nextQuery) setQuery(nextQuery);
    else if ("areaId" in body) setQuery(body);
    try {
      const data = await api.recommend(body, controller.signal);
      if (!controller.signal.aborted) setResult(data);
    } catch (e) {
      if (!controller.signal.aborted) setError(e as RequestError);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  function initialize() {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    return api
      .areas(controller.signal)
      .then(async (data) => {
        if (controller.signal.aborted) return;
        setAreas(data);
        setError(undefined);
        const first = {
          areaId: data.defaultAreaId,
          windowMinutes: data.filters.defaultWindowMinutes,
        };
        if (!data.areas.length) {
          setBusy(false);
          return;
        }
        await search(first, first);
      })
      .catch((error: RequestError) => {
        if (!controller.signal.aborted) {
          setError(error);
          setBusy(false);
        }
      });
  }
  useEffect(() => {
    void initialize();
    AsyncStorage.getItem(KEY)
      .then((raw) => {
        if (!raw) return;
        const data: unknown = JSON.parse(raw);
        if (Array.isArray(data))
          setSaved(
            data
              .filter(
                (x): x is SavedPlace =>
                  !!x &&
                  typeof x.id === "string" &&
                  typeof x.name === "string" &&
                  typeof x.category === "string",
              )
              .slice(0, 200),
          );
      })
      .catch(() =>
        setStorageError("Saved places couldn’t be loaded on this device."),
      )
      .finally(() => {
        savedLoaded.current = true;
        setHydrated(true);
      });
    return () => {
      searchController.current?.abort();
      loadController.current?.abort();
    };
    // Initialization is intentionally once per mounted provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!savedLoaded.current || saveRevision === 0) return;
    writes.current = writes.current
      .then(() => AsyncStorage.setItem(KEY, JSON.stringify(saved)))
      .catch(() =>
        setStorageError("Your changes could not be saved on this device."),
      );
  }, [saved, saveRevision]);
  function toggleSaved(place: SavedPlace) {
    if (!hydrated) return;
    setSaveRevision((revision) => revision + 1);
    setSaved((old) =>
      old.some((x) => x.id === place.id)
        ? old.filter((x) => x.id !== place.id)
        : [place, ...old].slice(0, 200),
    );
  }
  return {
    areas,
    query,
    result,
    error,
    busy,
    search,
    initialize: () => {
      setBusy(true);
      setError(undefined);
      return initialize();
    },
    saved,
    toggleSaved,
    hydrated,
    storageError,
    outing,
    setOuting,
  };
}
const Context = createContext<ReturnType<typeof useAppState> | null>(null);
export function AppProvider({ children }: { children: ReactNode }) {
  const state = useAppState();
  return <Context.Provider value={state}>{children}</Context.Provider>;
}
export function useApp() {
  const value = useContext(Context);
  if (!value) throw new Error("AppProvider is missing");
  return value;
}
