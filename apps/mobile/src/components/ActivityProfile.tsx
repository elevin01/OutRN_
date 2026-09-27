import { useCallback, useMemo, useRef, useState } from "react";
import {
  type GestureResponderEvent,
  type PanResponderGestureState,
  Animated,
  PanResponder,
  Image,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import type { RecommendationItem } from "@outrn/contracts";
import { router } from "expo-router";
import { Copy, Icon, colors, s } from "./ui";
import { RequiredNotes } from "./PlaceCard";
import { PlaceArt } from "./PlaceArt";
import { duration, priceLabel, travelLabel } from "../lib/presentation";
import { demoMode } from "../lib/api";

/** Demo photos illustrate a category, never a particular fictional venue. */
export function ActivityProfile({
  item,
  position,
  onNext,
  onPrevious,
}: {
  item: RecommendationItem;
  position: string;
  onNext: () => void;
  onPrevious: () => void;
}) {
  const ignorePressUntil = useRef(0);
  const [offset] = useState(() => new Animated.Value(0));
  const onPanResponderRelease = useCallback(
    (_: GestureResponderEvent, g: PanResponderGestureState) => {
      ignorePressUntil.current = Date.now() + 350;
      offset.setValue(0);
      if (g.dx < -60) onNext();
      else if (g.dx > 60) onPrevious();
    },
    [offset, onNext, onPrevious],
  );
  const gesture = useMemo(
    () =>
      // PanResponder stores this callback; the ref is read/written only on user events.
      // eslint-disable-next-line react-hooks/refs
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) =>
          Math.abs(g.dx) > 18 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        onPanResponderMove: (_, g) =>
          offset.setValue(Math.max(-90, Math.min(90, g.dx))),
        onPanResponderRelease,
        onPanResponderTerminate: () => offset.setValue(0),
      }),
    [offset, onPanResponderRelease],
  );
  const { height, fontScale } = useWindowDimensions();
  const photo = /book|museum|gallery|library|arts|theatre/.test(
    item.category.id,
  )
    ? require("../../assets/photos/culture.jpg")
    : require("../../assets/photos/cafe.jpg");
  const detail = () => {
    if (Date.now() < ignorePressUntil.current) return;
    router.push({
      pathname: "/place/[id]",
      params: { id: item.placeId, itemId: item.id },
    });
  };
  return (
    <Animated.View
      {...gesture.panHandlers}
      style={[styles.card, { transform: [{ translateX: offset }] }]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`View ${item.name}`}
        onPress={detail}
        style={[
          styles.hero,
          {
            height: Math.max(
              220,
              Math.min(380, (height * 0.42) / Math.max(1, fontScale * 0.8)),
            ),
          },
        ]}
      >
        {demoMode ? (
          <Image
            source={photo}
            resizeMode="cover"
            style={StyleSheet.absoluteFill}
            accessible={false}
          />
        ) : (
          <View style={styles.fallback}>
            <PlaceArt category={item.category.id} />
            <Copy style={styles.fallbackLabel}>{item.category.label}</Copy>
            <Copy style={styles.fallbackNote}>
              A photo of this place is not available yet.
            </Copy>
          </View>
        )}
        <View style={styles.heroTop}>
          <Copy style={styles.badge}>{item.category.label}</Copy>
          <Copy style={styles.counter}>{position}</Copy>
        </View>
        {demoMode && (
          <Copy style={styles.photoCredit}>Mood photo · not the venue</Copy>
        )}
      </Pressable>
      <View style={styles.identity}>
        <Copy
          style={[
            styles.status,
            item.status === "check_first" && { color: colors.accent },
          ]}
        >
          {item.status === "ready" ? "READY TO GO" : "CHECK FIRST"}
        </Copy>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Read about ${item.name}`}
          onPress={detail}
        >
          <Copy accessibilityRole="header" style={styles.name}>
            {item.name}
          </Copy>
        </Pressable>
        <View style={styles.facts}>
          <Fact icon="navigation" value={travelLabel(item)} />
          <Fact
            icon="clock"
            value={`${duration(item.timing.usefulMinutes)} there`}
          />
          <Fact icon="credit-card" value={priceLabel(item.price)} />
        </View>
        {item.copy.sentence && (
          <Copy style={styles.reason}>{item.copy.sentence}</Copy>
        )}
        {(item.ageLimit ||
          item.caveats.length > 0 ||
          item.reasons.some((r) => r.required)) && (
          <View style={styles.notes}>
            <RequiredNotes item={item} />
          </View>
        )}
      </View>
    </Animated.View>
  );
}
function Fact({
  icon,
  value,
}: {
  icon: React.ComponentProps<typeof Icon>["name"];
  value: string;
}) {
  return (
    <View style={styles.fact}>
      <Icon name={icon} size={17} color={colors.muted} />
      <Copy style={styles.factText}>{value}</Copy>
    </View>
  );
}
const styles = StyleSheet.create({
  card: {
    width: "100%",
    backgroundColor: colors.surface,
    borderRadius: 28,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#E6E3D9",
  },
  hero: { width: "100%", overflow: "hidden", backgroundColor: colors.sage },
  heroTop: {
    position: "absolute",
    left: 16,
    right: 16,
    top: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 10,
  },
  badge: {
    backgroundColor: "rgba(255,255,255,0.94)",
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 5,
    fontSize: 12,
    lineHeight: 19,
    fontWeight: "600",
  },
  counter: {
    backgroundColor: "rgba(32,37,31,0.82)",
    color: "white",
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 5,
    fontSize: 12,
    lineHeight: 19,
  },
  photoCredit: {
    position: "absolute",
    bottom: 12,
    left: 16,
    color: "white",
    backgroundColor: "rgba(32,37,31,0.80)",
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 2,
    fontSize: 10,
    lineHeight: 16,
  },
  identity: { padding: 20, gap: 12, alignItems: "center" },
  status: {
    color: colors.green,
    fontSize: 10,
    lineHeight: 16,
    letterSpacing: 1.8,
    fontWeight: "700",
  },
  name: {
    textAlign: "center",
    fontSize: 29,
    lineHeight: 33,
    fontWeight: "700",
    letterSpacing: -1,
  },
  facts: {
    flexDirection: "row",
    alignSelf: "stretch",
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.border,
    paddingVertical: 13,
    marginTop: 3,
  },
  fact: { flex: 1, alignItems: "center", gap: 7, paddingHorizontal: 4 },
  factText: {
    textAlign: "center",
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "600",
  },
  reason: { ...s.muted, textAlign: "center", fontSize: 14, lineHeight: 21 },
  notes: {
    gap: 7,
    alignSelf: "stretch",
    backgroundColor: colors.warm,
    padding: 12,
    borderRadius: 14,
  },
  fallback: { flex: 1, justifyContent: "center", gap: 14 },
  fallbackLabel: {
    textAlign: "center",
    fontSize: 28,
    lineHeight: 32,
    fontWeight: "600",
  },
  fallbackNote: {
    textAlign: "center",
    fontSize: 12,
    lineHeight: 18,
    color: colors.muted,
  },
});
