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
import { usePreferences } from "./preferences";
import {
  initialQuery,
  nearestArea,
  requestTaste,
  type Setup,
  type Taste,
} from "../lib/onboarding";
import { deviceOrigin } from "../lib/device-location";
import { LocationProblem } from "../lib/location-request";
import { learn as learnFrom, type Signal } from "../lib/taste";
export type SavedPlace = { id: string; name: string; category: string };
export type Outing = {
  item: RecommendationItem;
  timezone: string;
  expiresAt: string;
  arrived: boolean;
};
const KEY = "outrn.saved.v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DISMISSED = 200;
function useAppState() {
  const preferences = usePreferences();
  const [areas, setAreas] = useState<AreasResponse>();
  const areasRef = useRef<AreasResponse | undefined>(undefined);
  const [initialized, setInitialized] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(true);
  const [setupNotice, setSetupNotice] = useState<string>();
  const [firstArrival, setFirstArrival] = useState(false);
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
  // Keep the existing feedback behavior, with one shared preference writer.
  const learned = useRef(new Set<string>());
  const dismissed = useRef<string[]>([]);
  function setTaste(taste: Taste) {
    void preferences.update({ taste });
  }
  // Happening soon: the same search, events only, beside the main one. Optional: a failure shows nothing.
  const [happening, setHappening] = useState<RecommendationResponse>();
  const [hiddenNudges, setHiddenNudges] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const happeningController = useRef<AbortController | null>(null);
  function refreshHappening(request: RecommendationRequest) {
    happeningController.current?.abort();
    const controller = new AbortController();
    happeningController.current = controller;
    // Who is going, when, how and for how much, and the taste; not the kind of place asked for.
    const {
      categories: _categories,
      cuisines: _cuisines,
      diets: _diets,
      features: _features,
      visitStyle: _visitStyle,
      ...rest
    } = request;
    api
      .recommend(withTaste({ ...rest, eventsOnly: true }), controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setHappening(data);
      })
      .catch(() => {
        if (!controller.signal.aborted) setHappening(undefined);
      });
  }
  /** Hide a nudge for this session (never stored). */
  function hideNudge(id: string) {
    setHiddenNudges((old) => new Set([...old, id]));
  }
  /** Current preferences on fresh searches; frozen cursors remain unchanged. */
  function withTaste(body: RecommendationsBody): RecommendationsBody {
    const offered = areasRef.current;
    if (!("areaId" in body) || !offered) return body;
    return {
      ...body,
      taste: requestTaste(preferences.current.current.taste, offered),
      ...(dismissed.current.length
        ? { dismissedIds: dismissed.current.slice(-MAX_DISMISSED) }
        : {}),
    };
  }
  function learn(
    item: Pick<RecommendationItem, "id" | "interests">,
    signal: Signal,
  ) {
    if (!preferences.ready) return;
    if (
      signal === "not_for_me" &&
      UUID.test(item.id) &&
      !dismissed.current.includes(item.id)
    )
      dismissed.current = [...dismissed.current, item.id].slice(-MAX_DISMISSED);
    const key = `${signal === "unsave" ? "save" : signal}:${item.id}`;
    if (signal === "unsave") {
      if (!learned.current.delete(key)) return;
    } else {
      if (learned.current.has(key)) return;
      learned.current.add(key);
    }
    const current = preferences.current.current.taste;
    const next = learnFrom(current, item.interests, signal);
    if (next !== current) setTaste(next);
  }
  async function search(
    body: RecommendationsBody,
    nextQuery?: RecommendationRequest,
  ) {
    if ("areaId" in body) {
      // A new area or party must never show the previous search's event nudge while loading.
      happeningController.current?.abort();
      setHappening(undefined);
    }
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    const offered = areasRef.current;
    const request = withTaste(body);
    if ("areaId" in request) {
      setQuery(request);
      const setup = preferences.current.current.setup;
      if (setup.completed && offered) {
        void preferences.update({
          setup: {
            ...setup,
            areaId: request.areaId,
            travelMode:
              request.travelMode ||
              offered.areas.find((area) => area.id === request.areaId)
                ?.defaultTravelMode,
            originSource: request.origin ? "device" : "area",
          },
        });
      }
    } else if (nextQuery) setQuery(nextQuery);
    try {
      const data = await api.recommend(request, controller.signal);
      if (!controller.signal.aborted) {
        setResult(data);
        if ("areaId" in request) refreshHappening(request);
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        const failure = e as RequestError;
        setError(failure);
        if (failure.fields?.some((field) => field.path === "origin")) {
          setSetupNotice(
            "Your location isn’t in this area’s coverage. Choose an area to explore.",
          );
          void preferences.update({
            setup: { ...preferences.current.current.setup, step: "area" },
          });
          setNeedsSetup(true);
        }
      }
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
        areasRef.current = data;
        setError(undefined);
        const setup = preferences.current.current.setup;
        if (!setup.completed || !data.areas.length) {
          setBusy(false);
          return;
        }
        let origin: RecommendationRequest["origin"];
        let restoredSetup = setup;
        if (setup.originSource === "device") {
          try {
            // Check existing authorization, never show a permission prompt on launch.
            origin = await deviceOrigin(false, controller.signal);
            const area = nearestArea(data.areas, origin);
            if (area) restoredSetup = { ...setup, areaId: area.id };
          } catch (error) {
            if (!controller.signal.aborted) {
              setSetupNotice(
                error instanceof LocationProblem
                  ? error.message
                  : "Choose a starting area.",
              );
              void preferences.update({ setup: { ...setup, step: "nearby" } });
              setNeedsSetup(true);
              setBusy(false);
            }
            return;
          }
        }
        if (controller.signal.aborted) return;
        const first = initialQuery(data, restoredSetup, origin);
        if (!first) {
          setSetupNotice(
            "Your previous area is no longer available. Choose another starting point.",
          );
          void preferences.update({ setup: { ...setup, step: "area" } });
          setNeedsSetup(true);
          setBusy(false);
          return;
        }
        setNeedsSetup(false);
        void search(first, first);
      })
      .catch((error: RequestError) => {
        if (!controller.signal.aborted) {
          setError(error);
          setBusy(false);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setInitialized(true);
      });
  }
  useEffect(() => {
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
      happeningController.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (preferences.ready) void initialize();
    // Wait for the stored taste before the first request. Later changes are explicit searches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferences.ready]);
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
  async function completeSetup(
    areaId: string,
    travelMode: Setup["travelMode"],
    origin?: RecommendationRequest["origin"],
  ) {
    const data = areasRef.current;
    if (!data?.areas.some((area) => area.id === areaId)) return;
    const setup: Setup = {
      version: 1,
      completed: true,
      step: "nearby",
      areaId,
      travelMode,
      originSource: origin ? "device" : "area",
    };
    const first = initialQuery(data, setup, origin);
    if (!first) return;
    await preferences.update({
      setup,
      taste: { ...preferences.current.current.taste, asked: true },
    });
    setSetupNotice(undefined);
    setFirstArrival(true);
    // Setup and result loading are separate. A failed search retries without replaying the wizard.
    void search(first, first);
    setNeedsSetup(false);
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
    storageError: preferences.error || storageError,
    outing,
    setOuting,
    initialized,
    needsSetup,
    taste: preferences.taste,
    setup: preferences.setup,
    setupNotice,
    updatePreferences: preferences.update,
    completeSetup,
    tasteHydrated: preferences.ready,
    setTaste,
    learn,
    firstArrival,
    dismissArrival: () => setFirstArrival(false),
    happening,
    hiddenNudges,
    hideNudge,
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
