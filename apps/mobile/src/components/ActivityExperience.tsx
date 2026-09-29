import { useCallback, useEffect, useRef, useState } from "react";
import {
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from "react-native";
import { router, useFocusEffect } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type {
  PlaceDetails,
  PlaceFact,
  RecommendationItem,
  RecommendationResponse,
} from "@outrn/contracts";
import { api, demoMode, RequestError } from "../lib/api";
import type { DemoContent } from "../lib/demo-content";
import {
  actionLabel,
  ageLabel,
  clock,
  isExpired,
  priceLabel,
  safeExternalUrl,
  travelLabel,
} from "../lib/presentation";
import { useApp } from "../state/app";
import { ActivityProfile } from "./ActivityProfile";
import { Community } from "./Community";
import { ExternalButton } from "./ExternalButton";
import { RequiredNotes } from "./PlaceCard";
import { Sheet } from "./Sheet";
import {
  Button,
  Copy,
  Icon,
  IconButton,
  Loading,
  Panel,
  Problem,
  colors,
  type IconName,
} from "./ui";

export function ActivityExperience({
  placeId,
  item,
  response,
  position,
  onNext,
  onPrevious,
  onRefresh,
  onBack,
}: {
  placeId: string;
  item?: RecommendationItem;
  response?: RecommendationResponse;
  position?: number;
  onNext?: () => void;
  onPrevious?: () => void;
  onRefresh?: () => void;
  onBack?: () => void;
}) {
  const {
    saved,
    toggleSaved,
    hydrated,
    storageError,
    setOuting,
    query,
    search,
    initialize,
  } = useApp();
  const [resource, setResource] = useState<{
    id: string;
    place?: PlaceDetails;
    error?: RequestError;
  }>();
  const [attempt, setAttempt] = useState(0);
  const [sheet, setSheet] = useState<"sources" | "maps">();
  const [linkError, setLinkError] = useState(false);
  const [mode, setMode] = useState<"walk" | "drive" | "transit">(
    item?.timing.travel.mode || "walk",
  );
  const [scrolled, setScrolled] = useState(false);
  const { height, fontScale } = useWindowDimensions();
  const [viewport, setViewport] = useState(height - 80);
  const heroHeight = useRef(viewport);
  const scroll = useRef<ScrollView>(null);
  const insets = useSafeAreaInsets();
  const [focused, setFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  const [now, setNow] = useState(() => Date.now());
  const place = resource?.id === placeId ? resource.place : undefined;
  const error = resource?.id === placeId ? resource.error : undefined;
  const name = item?.name || place?.name || "Activity";
  const category = item?.category || place?.category;
  const zone = response?.area.timezone || place?.timezone || "America/New_York";
  // Keep the inline check: Metro removes this module, its fictional posts, and all four
  // static photo requires from production exports. Imported demoMode cannot do that.
  /* eslint-disable @typescript-eslint/no-require-imports -- A static import would bundle demo assets in production. */
  const demo: DemoContent | undefined =
    process.env.EXPO_PUBLIC_DEMO_MODE === "true"
      ? (
          require("../lib/demo-content") as typeof import("../lib/demo-content")
        ).getDemoContent(category?.id || "")
      : undefined;
  /* eslint-enable @typescript-eslint/no-require-imports */
  const expired = !!response && !demoMode && isExpired(response, now);
  const closed =
    place?.status === "closed_permanently" ||
    place?.status === "closed_temporarily";
  const directions =
    place?.actions.directionsUrls[mode] ||
    (item?.timing.travel.mode === mode
      ? item.actions.directionsUrl
      : undefined);
  const goMaps = () => {
    setLinkError(false);
    const safe = directions && safeExternalUrl(directions);
    if (safe) void Linking.openURL(safe).catch(() => setLinkError(true));
  };
  const maps = () => {
    if (demoMode || (item && item.callToAction !== "go") || closed || expired)
      setSheet("maps");
    else goMaps();
  };
  const refresh = () => {
    if (onRefresh) onRefresh();
    else setAttempt((a) => a + 1);
  };
  const findFresh = () => {
    if (query) void search(query);
    else void initialize();
    router.replace("/");
  };
  useEffect(() => {
    const controller = new AbortController();
    api
      .place(placeId, controller.signal)
      .then((place) => {
        if (!controller.signal.aborted) setResource({ id: placeId, place });
      })
      .catch((error: RequestError) => {
        if (!controller.signal.aborted) setResource({ id: placeId, error });
      });
    return () => controller.abort();
  }, [placeId, attempt]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const start = () => {
    if (!item || !response || !place || closed) return;
    if (!demoMode && isExpired(response)) {
      setNow(Date.now());
      return;
    }
    setOuting({
      item,
      timezone: zone,
      expiresAt: response.expiresAt,
      arrived: false,
    });
    router.push("/outing");
  };
  const layout = (e: LayoutChangeEvent) =>
    setViewport(e.nativeEvent.layout.height);
  const facts = place?.facts || [];
  const missing = [
    ...(!/park|garden|waterfront|viewpoint/.test(category?.id || "") &&
    !facts.some((f) => /wait|queue/.test(f.attribute))
      ? [{ label: "Wait time", value: "Not reported", icon: "clock" as const }]
      : []),
    ...(!facts.some((f) => /crowd|occupancy/.test(f.attribute))
      ? [{ label: "Crowd", value: "Not reported", icon: "users" as const }]
      : []),
  ];
  return (
    <View style={styles.root} onLayout={layout}>
      {focused && <StatusBar style={scrolled ? "dark" : "light"} />}
      <ScrollView
        ref={scroll}
        testID="activity-stream"
        directionalLockEnabled
        nestedScrollEnabled
        showsVerticalScrollIndicator={false}
        onScroll={(e) => setScrolled(e.nativeEvent.contentOffset.y > 180)}
        scrollEventThrottle={32}
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={refresh}
            tintColor="white"
          />
        }
      >
        <View
          onLayout={(e) => {
            heroHeight.current = e.nativeEvent.layout.height;
          }}
        >
          <ActivityProfile
            key={placeId}
            item={expired ? undefined : item}
            place={place}
            name={name}
            category={category?.label || "Loading"}
            area={response?.area.name || "OutRN"}
            timezone={zone}
            photos={demo?.photos}
            height={viewport}
            saved={saved.some((p) => p.id === placeId)}
            saveDisabled={!hydrated || !category}
            mapsDisabled={!directions || !safeExternalUrl(directions)}
            onSave={() =>
              category &&
              toggleSaved({
                id: placeId,
                name: place?.name || name,
                category: category.id,
              })
            }
            onMaps={maps}
            onNext={onNext}
            onBack={onBack}
            onDetails={() =>
              scroll.current?.scrollTo({
                y: heroHeight.current - insets.top - 68,
                animated: true,
              })
            }
          />
        </View>
        <View style={styles.section} testID="before-you-go">
          <View style={styles.row}>
            <Copy accessibilityRole="header" style={styles.heading}>
              Before you go
            </Copy>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="View sources"
              onPress={() => setSheet("sources")}
              style={styles.sources}
            >
              <Icon name="info" size={15} color={colors.green} />
              <Copy style={styles.label}>Sources</Copy>
            </Pressable>
          </View>
          {storageError && (
            <Copy accessibilityRole="alert">{storageError}</Copy>
          )}
          {linkError && (
            <Copy accessibilityRole="alert">
              Couldn’t open Maps. Please try again.
            </Copy>
          )}
          {(closed || expired) && (
            <Panel warm>
              <Copy>
                {closed
                  ? "This place is no longer listed as operating."
                  : "This recommendation has expired."}
              </Copy>
              <Button label="Find fresh options" onPress={findFresh} />
            </Panel>
          )}
          {response?.request.atIsExplicit && (
            <Copy style={styles.sub}>
              For{" "}
              {new Date(response.asOf).toLocaleDateString("en-US", {
                timeZone: zone,
                month: "short",
                day: "numeric",
              })}{" "}
              at {clock(response.asOf, zone)}.
            </Copy>
          )}
          {item && (
            <>
              <Copy style={styles.admission}>{actionLabel(item)}</Copy>
              <RequiredNotes item={item} />
            </>
          )}
          {item?.event && (
            <Copy>
              Starts {clock(item.event.startsAt, zone)}
              {item.event.endsAt
                ? ` · Ends ${clock(item.event.endsAt, zone)}`
                : ""}
              {item.event.entryCutoffAt
                ? ` · Last entry ${clock(item.event.entryCutoffAt, zone)}`
                : ""}
            </Copy>
          )}
          {error ? (
            <Problem
              message={error.message}
              retry={
                error.retryable ? () => setAttempt((a) => a + 1) : undefined
              }
            />
          ) : !place ? (
            <Loading label="Getting the details…" />
          ) : (
            <>
              <View style={styles.grid}>
                {facts.map((fact, i) => (
                  <View
                    key={`${fact.attribute}-${i}`}
                    style={[styles.fact, fontScale > 1.15 && styles.wideFact]}
                  >
                    <Fact fact={fact} />
                  </View>
                ))}
                {!facts.some((f) => f.attribute === "price") && (
                  <View
                    style={[styles.fact, fontScale > 1.15 && styles.wideFact]}
                  >
                    <FactValue
                      icon="tag"
                      label="Price"
                      value={priceLabel(place.price)}
                    />
                  </View>
                )}
                {missing.map((f) => (
                  <View
                    key={f.label}
                    style={[styles.fact, fontScale > 1.15 && styles.wideFact]}
                  >
                    <FactValue {...f} detail="No current report" />
                  </View>
                ))}
              </View>
              {place.ageLimit && (
                <Copy style={styles.admission}>{ageLabel(place.ageLimit)}</Copy>
              )}
              <Copy style={styles.caption}>
                Visitor reports describe that visit. Conditions can change.
              </Copy>
            </>
          )}
        </View>
        <Community demo={demo} />
        <View style={styles.section}>
          <Copy accessibilityRole="header" style={styles.heading}>
            Getting there
          </Copy>
          <View style={styles.modes}>
            {(
              [
                ["walk", "Walk"],
                ["drive", "Drive"],
                ["transit", "Transit"],
              ] as const
            ).map(([value, label]) => (
              <Pressable
                key={value}
                accessibilityRole="button"
                accessibilityState={{
                  selected: mode === value,
                  disabled: !place && value !== mode,
                }}
                disabled={!place && value !== mode}
                onPress={() => setMode(value)}
                style={[
                  styles.mode,
                  mode === value && { backgroundColor: colors.sage },
                ]}
              >
                <Copy style={styles.label}>{label}</Copy>
              </Pressable>
            ))}
          </View>
          <Copy style={styles.travel}>
            {item && !expired && mode === item.timing.travel.mode
              ? travelLabel(item)
              : "Check in Maps"}
          </Copy>
          <Copy style={styles.sub}>
            {response?.request.originIsDefault !== false
              ? "From the area center, not your phone’s location."
              : "From your chosen starting point."}
          </Copy>
          {item?.timing.travel.isEstimate &&
            mode === item.timing.travel.mode && (
              <Copy style={styles.caption}>
                Estimated travel time. Check the route before leaving.
              </Copy>
            )}
          {place?.address && <Copy>{place.address}</Copy>}
          {mode === "drive" && (
            <View style={styles.grid}>
              <View style={styles.fact}>
                <FactValue
                  icon="navigation"
                  label="Traffic"
                  value="Not available"
                  detail="Check current conditions in Maps"
                />
              </View>
              <View style={styles.fact}>
                <FactValue
                  icon="map-pin"
                  label="Parking"
                  value="Not confirmed"
                  detail={
                    item?.timing.travel.mode === "drive" &&
                    item.timing.travel.parkingMinutes !== null
                      ? `Estimate includes ${item.timing.travel.parkingMinutes} min for parking, not a space guarantee.`
                      : "Availability not reported"
                  }
                />
              </View>
            </View>
          )}
          <Button
            label="Open directions"
            secondary
            icon="arrow-up-right"
            disabled={!directions}
            onPress={maps}
          />
        </View>
        <View style={styles.section}>
          <Copy accessibilityRole="header" style={styles.heading}>
            Your plan
          </Copy>
          <View style={styles.step}>
            <Copy style={styles.stepNumber}>1</Copy>
            <View style={styles.stepCopy}>
              <Copy style={styles.strong}>Head over when you’re ready</Copy>
              <Copy style={styles.sub}>
                Check the hours and admission first.
              </Copy>
            </View>
          </View>
          <View style={styles.step}>
            <Copy style={styles.stepNumber}>2</Copy>
            <View style={styles.stepCopy}>
              <Copy style={styles.strong}>{name}</Copy>
              <Copy style={styles.sub}>
                Take your time. Keep the venue’s hours in mind.
              </Copy>
            </View>
          </View>
          {response?.request.backBy && (
            <Copy>
              Your return deadline: {clock(response.request.backBy, zone)}.
            </Copy>
          )}
          {item?.callToAction === "book" && (
            <Copy style={styles.admission}>
              Book with the venue before leaving. OutRN hasn’t reserved
              anything.
            </Copy>
          )}
          {(item?.actions.websiteUrl || place?.contact.websiteUrl) && (
            <ExternalButton
              url={(item?.actions.websiteUrl || place?.contact.websiteUrl)!}
              label={
                item?.callToAction === "book"
                  ? "Check booking on website"
                  : "Venue website"
              }
            />
          )}
          {place?.contact.phone && (
            <ExternalButton
              url={place.contact.phone}
              label="Call the venue"
              phone
            />
          )}
          {item && !expired && !closed ? (
            <Button
              label="Start this outing"
              icon="arrow-up-right"
              disabled={!place}
              onPress={start}
            />
          ) : (
            <Button label="Find fresh options" onPress={findFresh} />
          )}
        </View>
        <View style={styles.section}>
          {onNext && (
            <Button
              secondary
              label="See the next activity"
              icon="arrow-right"
              onPress={onNext}
            />
          )}
          {onPrevious && (
            <Button secondary label="Previous activity" onPress={onPrevious} />
          )}
          <Button
            secondary
            label="Plans & preferences"
            icon="sliders"
            onPress={() => router.push("/filters")}
          />
          {position && <Copy style={styles.caption}>Activity {position}</Copy>}
          {response?.insufficient && (
            <>
              <Copy>
                {response.insufficient.found}{" "}
                {response.insufficient.found === 1
                  ? "activity fits"
                  : "activities fit"}{" "}
                this search.
              </Copy>
              {response.insufficient.relaxations.map((r) => (
                <Copy key={r.code} style={styles.sub}>
                  {r.text} · {r.admits} more
                </Copy>
              ))}
            </>
          )}
          <Copy style={styles.caption}>
            {[
              ...new Set([
                ...(response?.attributions || []),
                ...(place?.attributions || []),
              ]),
            ].join(" · ")}
            {demo ? " · Illustrative photos: Unsplash" : ""}
          </Copy>
        </View>
      </ScrollView>
      {scrolled && (
        <View style={[styles.context, { paddingTop: insets.top + 8 }]}>
          <View style={{ flex: 1 }}>
            <Copy style={styles.strong}>{name}</Copy>
            <Copy style={styles.caption}>Details & community</Copy>
          </View>
          <IconButton
            name="arrow-up"
            label="Back to activity photo"
            onPress={() => scroll.current?.scrollTo({ y: 0, animated: true })}
          />
        </View>
      )}
      <Sheet
        title={sheet === "sources" ? "Sources" : "Before you head out"}
        visible={!!sheet}
        close={() => setSheet(undefined)}
      >
        {sheet === "sources" ? (
          <>
            {demoMode && (
              <Copy style={styles.admission}>
                Demo sources from invented fixtures.
              </Copy>
            )}
            {facts.map((f, i) => (
              <View style={styles.sourceRow} key={`${f.attribute}-${i}`}>
                <Copy style={styles.strong}>{f.label}</Copy>
                <Copy>
                  {f.provenance.sources.map((s) => s.label).join(" · ") ||
                    "No source available"}
                </Copy>
                <Copy style={styles.caption}>{f.provenance.summary}</Copy>
                {f.provenance.conflict && (
                  <Copy style={styles.admission}>
                    Sources disagree. Check with the venue.
                  </Copy>
                )}
                {f.provenance.dueForRecheck && (
                  <Copy style={styles.admission}>Due for another check.</Copy>
                )}
              </View>
            ))}
            {!facts.length && (
              <Copy>
                {error
                  ? "Sources couldn’t be loaded. Try the details again."
                  : "Sources are loading with the place details."}
              </Copy>
            )}
            <Copy style={styles.caption}>
              A source retrieval is not a verification. Estimates and visitor
              reports may have changed.
            </Copy>
            <Copy style={styles.caption}>
              {place?.attributions.join(" · ")}
            </Copy>
          </>
        ) : (
          <>
            {demoMode ? (
              <Copy>
                These are invented places. In the live app, Maps opens
                directions to the selected activity.
              </Copy>
            ) : (
              <>
                {item && (
                  <>
                    <Copy style={styles.admission}>{actionLabel(item)}</Copy>
                    <RequiredNotes item={item} />
                  </>
                )}
                {closed || expired ? (
                  <Button
                    label="Find fresh options"
                    onPress={() => {
                      setSheet(undefined);
                      findFresh();
                    }}
                  />
                ) : (
                  <>
                    {item?.callToAction === "book" && (
                      <Copy>
                        Confirm your booking with the venue. OutRN hasn’t
                        reserved anything.
                      </Copy>
                    )}
                    {item?.actions.websiteUrl && (
                      <ExternalButton
                        url={item.actions.websiteUrl}
                        label={
                          item.callToAction === "book"
                            ? "Check booking on website"
                            : "Venue website"
                        }
                      />
                    )}
                    <Button
                      label="Continue to Maps"
                      disabled={!directions}
                      onPress={goMaps}
                    />
                    {linkError && (
                      <Copy accessibilityRole="alert">
                        Couldn’t open Maps. Please try again.
                      </Copy>
                    )}
                  </>
                )}
              </>
            )}
          </>
        )}
      </Sheet>
    </View>
  );
}
function Fact({ fact }: { fact: PlaceFact }) {
  const prefix =
    fact.provenance.evidence === "estimate"
      ? "Estimate"
      : fact.provenance.evidence === "reported"
        ? "Reported"
        : undefined;
  return (
    <FactValue
      icon={
        fact.attribute === "opening_hours"
          ? "clock"
          : fact.attribute === "price"
            ? "tag"
            : "info"
      }
      label={fact.label}
      value={fact.value}
      detail={[
        prefix,
        fact.detail,
        fact.provenance.freshness,
        fact.provenance.conflict ? "Sources disagree" : null,
        fact.provenance.dueForRecheck ? "Due for a recheck" : null,
      ]
        .filter(Boolean)
        .join(" · ")}
    />
  );
}
function FactValue({
  icon,
  label,
  value,
  detail,
}: {
  icon: IconName;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <>
      <View style={styles.factLabel}>
        <Icon name={icon} size={18} color={colors.green} />
        <Copy style={styles.sub}>{label}</Copy>
      </View>
      <Copy style={styles.strong}>{value}</Copy>
      {!!detail && <Copy style={styles.caption}>{detail}</Copy>}
    </>
  );
}
const styles = StyleSheet.create({
  root: {
    flex: 1,
    width: "100%",
    maxWidth: 600,
    alignSelf: "center",
    backgroundColor: colors.paper,
  },
  section: {
    padding: 24,
    gap: 16,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  heading: {
    fontSize: 20,
    lineHeight: 26,
    fontWeight: "600",
    letterSpacing: -0.4,
  },
  label: { fontSize: 13, lineHeight: 19, fontWeight: "500" },
  sub: { fontSize: 13, lineHeight: 20, color: colors.muted },
  caption: { fontSize: 12, lineHeight: 18, color: colors.muted },
  strong: { fontSize: 15, lineHeight: 22, fontWeight: "600" },
  sources: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 12,
    borderRadius: 22,
    backgroundColor: colors.sage,
  },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 20 },
  fact: { flexBasis: "44%", flexGrow: 1, gap: 5 },
  wideFact: { flexBasis: "100%" },
  factLabel: { flexDirection: "row", gap: 8, alignItems: "center" },
  admission: {
    color: colors.accent,
    fontSize: 13,
    lineHeight: 20,
    fontWeight: "500",
  },
  modes: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  mode: {
    minHeight: 44,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 24,
  },
  travel: { fontSize: 24, lineHeight: 30, fontWeight: "600" },
  step: { flexDirection: "row", gap: 14 },
  stepNumber: {
    width: 32,
    height: 32,
    lineHeight: 32,
    textAlign: "center",
    backgroundColor: colors.sage,
    borderRadius: 16,
  },
  stepCopy: { flex: 1, gap: 3 },
  context: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    padding: 16,
    paddingBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.paper,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  sourceRow: {
    gap: 6,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
});
