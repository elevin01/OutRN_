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
import {
  EMPTY_TASTE,
  learn as learnFrom,
  parseTaste,
  requestTaste,
  type Signal,
  type Taste,
} from "../lib/taste";
export type SavedPlace = { id: string; name: string; category: string };
export type Outing = {
  item: RecommendationItem;
  timezone: string;
  expiresAt: string;
  arrived: boolean;
};
const KEY = "outrn.saved.v1";
const TASTE_KEY = "outrn.taste.v1";
/** Ids the API takes as dismissed (UUIDs), and how many it takes. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DISMISSED = 200;
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
  const [taste, setTasteState] = useState<Taste>(EMPTY_TASTE);
  const [tasteHydrated, setTasteHydrated] = useState(false);
  const tasteRef = useRef<Taste>(EMPTY_TASTE);
  const tasteWrites = useRef(Promise.resolve());
  // This session only, never stored: what was already learned from (one nudge per option and action),
  // and what was turned down (left out of fresh searches for the rest of it).
  const learned = useRef(new Set<string>());
  const dismissed = useRef<string[]>([]);
  const areasRef = useRef<AreasResponse | undefined>(undefined);
  /** A fresh search carries the taste and what was turned down; a cursor replays its own. */
  function withTaste(body: RecommendationsBody): RecommendationsBody {
    if (!("areaId" in body)) return body;
    const offered = areasRef.current?.filters.interests.map((i) => i.id);
    const max = areasRef.current?.limits.maxTaste;
    const t = requestTaste(tasteRef.current, offered).slice(0, max ?? undefined);
    const ids = dismissed.current.slice(-MAX_DISMISSED);
    return {
      ...body,
      ...(t.length ? { taste: t } : { taste: undefined }),
      ...(ids.length ? { dismissedIds: ids } : {}),
    };
  }
  function updateTaste(next: Taste) {
    if (next === tasteRef.current) return;
    tasteRef.current = next;
    setTasteState(next);
    tasteWrites.current = tasteWrites.current
      .then(() => AsyncStorage.setItem(TASTE_KEY, JSON.stringify(next)))
      .catch(() =>
        setStorageError("Your interests could not be saved on this device."),
      );
  }
  /** Going, saving or turning down an option nudges the interests it is, once per option and action. */
  function learn(item: Pick<RecommendationItem, "id" | "interests">, signal: Signal) {
    if (!tasteHydrated) return;
    if (signal === "not_for_me" && UUID.test(item.id) && !dismissed.current.includes(item.id))
      dismissed.current = [...dismissed.current, item.id].slice(-MAX_DISMISSED);
    // Saving and unsaving undo each other; the rest count once.
    const key = `${signal === "unsave" ? "save" : signal}:${item.id}`;
    if (signal === "unsave") {
      if (!learned.current.delete(key)) return;
    } else {
      if (learned.current.has(key)) return;
      learned.current.add(key);
    }
    updateTaste(learnFrom(tasteRef.current, item.interests, signal));
  }
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
      const data = await api.recommend(withTaste(body), controller.signal);
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
        areasRef.current = data;
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
    // The taste first, so the first search already carries it.
    AsyncStorage.getItem(TASTE_KEY)
      .then((raw) => {
        const t = raw ? parseTaste(JSON.parse(raw)) : EMPTY_TASTE;
        tasteRef.current = t;
        setTasteState(t);
      })
      .catch(() =>
        setStorageError("Your interests couldn’t be loaded on this device."),
      )
      .finally(() => {
        setTasteHydrated(true);
        void initialize();
      });
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
    taste,
    tasteHydrated,
    setTaste: updateTaste,
    learn,
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
