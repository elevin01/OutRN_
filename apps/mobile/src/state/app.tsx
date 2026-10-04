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
import { useSavedLibrary } from "./saved-library";
import type { SavedMatch } from "../lib/saved-now";
export type { SavedPlace } from "../lib/saved-library";
export type Outing = {
  item: RecommendationItem;
  timezone: string;
  expiresAt: string;
  arrived: boolean;
};
function useAppState() {
  const [areas, setAreas] = useState<AreasResponse>();
  const [query, setQuery] = useState<RecommendationRequest>();
  const [result, setResult] = useState<RecommendationResponse>();
  const [error, setError] = useState<RequestError>();
  const [busy, setBusy] = useState(true);
  const library = useSavedLibrary();
  const [savedPlan, setSavedPlan] = useState<SavedMatch>();
  const [outing, setOuting] = useState<Outing>();
  const searchController = useRef<AbortController | null>(null);
  const loadController = useRef<AbortController | null>(null);
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
    return () => {
      searchController.current?.abort();
      loadController.current?.abort();
    };
    // Initialization is intentionally once per mounted provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
    ...library,
    savedPlan,
    setSavedPlan,
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
