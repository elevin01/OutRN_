import { useEffect, useState } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import type { RecommendationResponse } from "@outrn/contracts";
import { useApp } from "../../state/app";
import {
  Button,
  Copy,
  Heading,
  IconButton,
  Loading,
  Panel,
  Problem,
  Row,
  Screen,
  colors,
  s,
} from "../../components/ui";
import { ActivityProfile } from "../../components/ActivityProfile";
import { demoMode } from "../../lib/api";
import { isExpired } from "../../lib/presentation";
export default function NowScreen() {
  const { areas, query, result, busy, error, search, initialize, outing } =
    useApp();
  const [startAtEnd, setStartAtEnd] = useState<{
    requestId: string;
    offset: number;
    queryKey: string;
  }>();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const refresh = () => {
    setStartAtEnd(undefined);
    if (query) void search(query);
    else void initialize();
  };
  const expired = result && !demoMode && isExpired(result, now);
  return (
    <Screen
      contentStyle={styles.screen}
      refreshControl={
        <RefreshControl
          refreshing={busy}
          onRefresh={refresh}
          tintColor={colors.green}
        />
      }
    >
      <View style={styles.header}>
        <IconButton
          name={outing ? "navigation" : "refresh-cw"}
          label={outing ? "Open your outing" : "Refresh activities"}
          onPress={outing ? () => router.push("/outing") : refresh}
        />
        <Copy style={styles.wordmark}>
          OutRN<Copy style={{ color: colors.signal, fontSize: 26 }}>↗</Copy>
        </Copy>
        <IconButton
          name="sliders"
          label="Adjust your plans"
          onPress={() => router.push("/filters")}
        />
      </View>
      {busy ? (
        <Loading />
      ) : error ? (
        <Problem
          message={error.message}
          retry={
            error.retryable || error.code.startsWith("CURSOR_")
              ? () => {
                  if (error.restart || query)
                    void search((error.restart || query)!);
                  else void initialize();
                }
              : undefined
          }
          label={
            error.code.startsWith("CURSOR_")
              ? "Find fresh options"
              : "Try again"
          }
        />
      ) : !areas?.areas.length ? (
        <Panel>
          <Heading>More places soon.</Heading>
          <Copy>
            There are no supported areas yet. Check back in a little while.
          </Copy>
          <Button label="Check again" onPress={refresh} />
        </Panel>
      ) : (
        result && (
          <>
            {expired ? (
              <Panel warm>
                <Heading>Time for a fresh plan.</Heading>
                <Copy>
                  These recommendations have aged. Refresh before heading out.
                </Copy>
                <Button label="Find fresh options" onPress={refresh} />
              </Panel>
            ) : (
              <ActivityDeck
                key={`${result.requestId}:${result.page.offset}`}
                result={result}
                startAtEnd={
                  startAtEnd?.requestId === result.requestId &&
                  startAtEnd?.offset === result.page.offset &&
                  startAtEnd?.queryKey === JSON.stringify(query)
                }
                page={async (cursor, backwards) => {
                  setStartAtEnd(
                    backwards
                      ? {
                          requestId: result.requestId,
                          queryKey: JSON.stringify(query),
                          offset: Math.max(
                            0,
                            result.page.offset - result.page.size,
                          ),
                        }
                      : undefined,
                  );
                  await search({ cursor });
                }}
              />
            )}
          </>
        )
      )}
    </Screen>
  );
}
function ActivityDeck({
  result,
  startAtEnd,
  page,
}: {
  result: RecommendationResponse;
  startAtEnd: boolean;
  page: (cursor: string, backwards: boolean) => Promise<void>;
}) {
  const { saved, toggleSaved, hydrated, storageError } = useApp();
  const [index, setIndex] = useState(
    startAtEnd ? Math.max(0, result.items.length - 1) : 0,
  );
  const item = result.items[index];
  const atEnd = index === result.items.length;
  const back = () => {
    if (index > 0) setIndex(index - 1);
    else if (result.page.prevCursor) void page(result.page.prevCursor, true);
  };
  const next = () => {
    if (index < result.items.length - 1) setIndex(index + 1);
    else if (result.page.nextCursor) void page(result.page.nextCursor, false);
    else setIndex(result.items.length);
  };
  const isSaved = !!item && saved.some((p) => p.id === item.placeId);
  return (
    <>
      {item ? (
        <>
          <ActivityProfile
            item={item}
            onNext={next}
            onPrevious={back}
            position={`${result.page.offset + index + 1}`}
          />
          <Row style={styles.actions}>
            <View style={styles.smallAction}>
              <IconButton
                name="chevron-left"
                label="Previous activity"
                disabled={index === 0 && !result.page.prevCursor}
                onPress={back}
              />
              <Copy style={styles.actionLabel}>Back</Copy>
            </View>
            <View style={styles.primary}>
              <Button
                label="Details"
                icon="arrow-up-right"
                onPress={() =>
                  router.push({
                    pathname: "/place/[id]",
                    params: { id: item.placeId, itemId: item.id },
                  })
                }
              />
            </View>
            <View style={styles.smallAction}>
              <IconButton
                name="bookmark"
                selected={isSaved}
                disabled={!hydrated}
                label={isSaved ? "Remove activity from saved" : "Save activity"}
                onPress={() => {
                  if (hydrated)
                    toggleSaved({
                      id: item.placeId,
                      name: item.name,
                      category: item.category.id,
                    });
                }}
              />
              <Copy style={styles.actionLabel}>
                {isSaved ? "Saved" : "Save"}
              </Copy>
            </View>
            <View style={styles.smallAction}>
              <IconButton
                name="arrow-right"
                label="Next activity"
                onPress={next}
              />
              <Copy style={styles.actionLabel}>Next</Copy>
            </View>
          </Row>
          {storageError && (
            <Copy accessibilityRole="alert">{storageError}</Copy>
          )}
          {result.insufficient && (
            <Copy style={styles.supply}>
              {result.insufficient.found}{" "}
              {result.insufficient.found === 1
                ? "activity fits"
                : "activities fit"}{" "}
              this search. More possibilities in your preferences.
            </Copy>
          )}
        </>
      ) : (
        <Panel>
          <Heading>
            {atEnd && result.items.length
              ? "That’s your shortlist."
              : "Nothing quite fits. Yet."}
          </Heading>
          <Copy>
            {result.items.length
              ? "A few good possibilities. Revisit one, or adjust what you’re looking for."
              : "Try a different time, budget, or kind of place."}
          </Copy>
          {result.items.length > 0 && (
            <Button label="See activities again" onPress={() => setIndex(0)} />
          )}
          <Button
            label="Adjust your plans"
            secondary
            onPress={() => router.push("/filters")}
          />
        </Panel>
      )}
      {(!item || result.insufficient) &&
        result.insufficient?.relaxations.map((r) => (
          <Copy key={r.code} style={styles.supply}>
            {r.text} · {r.admits} more
          </Copy>
        ))}
      <Copy style={styles.attribution}>
        {result.attributions.join(" · ")}
        {demoMode ? " · Mood photos: Unsplash" : ""}
      </Copy>
    </>
  );
}
const styles = StyleSheet.create({
  screen: {
    padding: 12,
    paddingTop: 8,
    gap: 12,
    maxWidth: 560,
    paddingBottom: 20,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 4,
  },
  wordmark: {
    fontSize: 25,
    fontWeight: "800",
    letterSpacing: -1,
    textAlign: "center",
  },
  actions: {
    justifyContent: "space-evenly",
    gap: 10,
    paddingHorizontal: 4,
    alignItems: "flex-start",
  },
  smallAction: { alignItems: "center", gap: 4 },
  actionLabel: { fontSize: 10, lineHeight: 14, color: colors.muted },
  primary: { flex: 1, paddingTop: 0 },
  supply: {
    ...s.muted,
    textAlign: "center",
    fontSize: 13,
    lineHeight: 19,
    paddingHorizontal: 12,
  },
  attribution: {
    ...s.muted,
    textAlign: "center",
    fontSize: 10,
    lineHeight: 15,
  },
});
