import { useEffect, useState } from "react";
import { Pressable, RefreshControl, View } from "react-native";
import { router } from "expo-router";
import { useApp } from "../../state/app";
import {
  Button,
  Copy,
  Eyebrow,
  Heading,
  Icon,
  IconButton,
  Loading,
  Panel,
  Problem,
  Row,
  Screen,
  colors,
  s,
} from "../../components/ui";
import { PlaceCard } from "../../components/PlaceCard";
import { demoMode } from "../../lib/api";
import { duration, isExpired } from "../../lib/presentation";
export default function NowScreen() {
  const { areas, query, result, busy, error, search, initialize, outing } =
    useApp();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const refresh = () => {
    if (query) void search(query);
    else void initialize();
  };
  const area = areas?.areas.find((a) => a.id === query?.areaId);
  const expired = result && !demoMode && isExpired(result, now);
  return (
    <Screen
      refreshControl={
        <RefreshControl
          refreshing={busy}
          onRefresh={refresh}
          tintColor={colors.green}
        />
      }
    >
      <Row style={s.between}>
        <Copy style={{ fontSize: 26, fontWeight: "800", letterSpacing: -1 }}>
          OutRN<Copy style={{ color: colors.signal, fontSize: 28 }}>↗</Copy>
        </Copy>
        <IconButton
          name="sliders"
          label="Adjust your plans"
          onPress={() => router.push("/filters")}
        />
      </Row>
      <View style={{ gap: 8 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Choose your area"
          onPress={() => router.push("/areas")}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <Row>
            <Icon name="map-pin" size={15} color={colors.accent} />
            <Eyebrow>{area?.name || "Choose your area"}</Eyebrow>
            <Icon name="chevron-down" size={14} />
          </Row>
        </Pressable>
        <Heading>A good few{"\n"}hours ahead.</Heading>
        <Copy style={s.muted}>Less planning. More getting out.</Copy>
      </View>
      {query && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Edit time, travel and budget"
          onPress={() => router.push("/filters")}
          style={{
            padding: 17,
            backgroundColor: colors.sage,
            borderRadius: 18,
          }}
        >
          <Row style={s.between}>
            <Row>
              <Icon name="clock" size={18} />
              <Copy style={{ fontWeight: "600" }}>
                {duration(query.windowMinutes)} free
              </Copy>
            </Row>
            <Copy style={{ textTransform: "capitalize" }}>
              {query.travelMode || area?.defaultTravelMode}{" "}
              <Icon name="chevron-down" size={14} />
            </Copy>
          </Row>
        </Pressable>
      )}
      {outing && (
        <Button
          label={`Your outing · ${outing.item.name}`}
          secondary
          icon="arrow-right"
          onPress={() => router.push("/outing")}
        />
      )}
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
            {expired && (
              <Panel warm>
                <Copy>These plans have aged. Refresh before heading out.</Copy>
                <Button label="Find fresh options" onPress={refresh} />
              </Panel>
            )}
            <Row style={s.between}>
              <Eyebrow>
                {result.page.offset
                  ? "A few more possibilities"
                  : "Your shortlist"}
              </Eyebrow>
              <Copy style={{ fontSize: 13, color: colors.muted }}>
                {result.items.length}{" "}
                {result.items.length === 1 ? "option" : "options"}
              </Copy>
            </Row>
            {result.insufficient && (
              <Panel>
                <Heading>
                  {result.items.length
                    ? "A shorter shortlist."
                    : "Nothing quite fits. Yet."}
                </Heading>
                <Copy>
                  {result.insufficient.found} of {result.insufficient.wanted}{" "}
                  options fit this search.
                </Copy>
                {result.insufficient.relaxations.map((r) => (
                  <Copy key={r.code}>
                    {r.text} · {r.admits} more
                  </Copy>
                ))}
                <Button
                  label="Adjust your plans"
                  secondary
                  onPress={() => router.push("/filters")}
                />
              </Panel>
            )}
            {result.items.map((item, i) => (
              <PlaceCard
                key={item.id}
                item={item}
                index={result.page.offset + i}
                featured={i === 0}
              />
            ))}
            <Row>
              {result.page.prevCursor && (
                <View style={{ flex: 1 }}>
                  <Button
                    label="Previous"
                    secondary
                    onPress={() =>
                      void search({ cursor: result.page.prevCursor! })
                    }
                  />
                </View>
              )}
              {result.page.nextCursor && (
                <View style={{ flex: 1 }}>
                  <Button
                    label="More options"
                    secondary
                    icon="arrow-right"
                    onPress={() =>
                      void search({ cursor: result.page.nextCursor! })
                    }
                  />
                </View>
              )}
            </Row>
            <Copy style={[s.muted, { fontSize: 12, textAlign: "center" }]}>
              A shortlist, not an endless scroll.{"\n"}
              {result.attributions.join(" · ")}
            </Copy>
          </>
        )
      )}
    </Screen>
  );
}
