import { useMemo, useState } from "react";
import {
  Image,
  PanResponder,
  Pressable,
  StyleSheet,
  View,
  type ImageSourcePropType,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { PlaceDetails, RecommendationItem } from "@outrn/contracts";
import { Copy, Icon, type IconName } from "./ui";
import { RequiredNotes } from "./PlaceCard";
import {
  actionLabel,
  clock,
  priceLabel,
  travelLabel,
} from "../lib/presentation";
import { demoMode } from "../lib/api";

export function ActivityProfile({
  item,
  place,
  name,
  category,
  area,
  timezone,
  photos = [],
  height,
  saved,
  saveDisabled,
  mapsDisabled,
  onSave,
  onMaps,
  onNext,
  onDetails,
  onBack,
  introduction,
}: {
  item?: RecommendationItem;
  place?: PlaceDetails;
  name: string;
  category: string;
  area: string;
  timezone: string;
  photos?: ImageSourcePropType[];
  height: number;
  saved: boolean;
  saveDisabled: boolean;
  mapsDisabled: boolean;
  onSave: () => void;
  onMaps: () => void;
  onNext?: () => void;
  onDetails: () => void;
  onBack?: () => void;
  introduction?: string;
}) {
  const [photo, setPhoto] = useState(0);
  const inset = useSafeAreaInsets();
  const gesture = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) =>
          photos.length > 1 &&
          Math.abs(g.dx) > 18 &&
          Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        onPanResponderRelease: (_, g) => {
          if (Math.abs(g.dx) > 55 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5)
            setPhoto(
              (p) => (p + (g.dx < 0 ? 1 : photos.length - 1)) % photos.length,
            );
        },
      }),
    [photos.length],
  );
  const categoryId = item?.category.id || place?.category.id || "";
  const nature = /park|garden|waterfront|viewpoint/.test(categoryId);
  const artIcon: IconName = nature
    ? "sun"
    : /museum|book|gallery|library|arts/.test(categoryId)
      ? "book-open"
      : /bar|music|night/.test(categoryId)
        ? "music"
        : "compass";
  const description =
    item?.kind === "event"
      ? `At ${item.placeName}`
      : place?.address ||
        item?.reasons
          .filter(
            (r) =>
              !r.required &&
              !["ENOUGH_TIME", "OPEN_LATE", "SHORT_TRAVEL", "FREE"].includes(
                r.code,
              ),
          )
          .slice(0, 2)
          .map((r) => r.text)
          .join(" · ");
  return (
    <View
      testID="activity-hero"
      style={[styles.hero, { minHeight: height, paddingTop: inset.top + 16 }]}
      {...gesture.panHandlers}
    >
      {photos[photo] ? (
        <Image
          testID="activity-photo"
          source={photos[photo]}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          accessibilityLabel={`Illustrative photo ${photo + 1} of ${photos.length}, not this venue`}
        />
      ) : (
        <View
          pointerEvents="none"
          accessible={false}
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: nature ? "#607767" : "#62605E" },
          ]}
        >
          <View style={styles.artCircle} />
          <View style={styles.artArch}>
            <Icon name={artIcon} size={76} color="#E0E9D8" />
          </View>
        </View>
      )}
      <LinearGradient
        pointerEvents="none"
        colors={["#101b1455", "#101b1400", "#14281cbb", "#14281cf5"]}
        locations={[0, 0.27, 0.64, 1]}
        style={StyleSheet.absoluteFill}
      />
      <View style={styles.header}>
        {onBack ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            onPress={onBack}
            style={styles.headerButton}
          >
            <Icon name="arrow-left" color="white" />
          </Pressable>
        ) : (
          <Copy style={styles.logo}>
            OutRN<Copy style={{ color: "#F36B3F" }}>↗</Copy>
          </Copy>
        )}
        <Copy style={styles.area}>{area}</Copy>
      </View>
      {introduction && (
        <Copy style={[styles.caption, { fontSize: 13, lineHeight: 19 }]}>
          {introduction}
        </Copy>
      )}
      <Copy style={styles.caption}>
        {demoMode
          ? "Demo places · illustrative photos and posts"
          : photos.length
            ? ""
            : "Category artwork · venue photos not available"}
      </Copy>
      {photos.length > 0 && (
        <Copy style={styles.counter}>
          {photo + 1} / {photos.length}
        </Copy>
      )}
      <View style={styles.spacer} />
      <View style={styles.bottom}>
        <View style={styles.copy}>
          {photos.length > 1 && (
            <View style={styles.dots}>
              {photos.map((_, i) => (
                <Pressable
                  key={i}
                  accessibilityRole="button"
                  accessibilityLabel={`Show photo ${i + 1}`}
                  accessibilityState={{ selected: photo === i }}
                  onPress={() => setPhoto(i)}
                  style={styles.dotHit}
                >
                  <View
                    style={[styles.dot, i === photo && styles.dotSelected]}
                  />
                </Pressable>
              ))}
            </View>
          )}
          <Copy style={styles.kind}>{category}</Copy>
          <Copy accessibilityRole="header" style={styles.title}>
            {name}
          </Copy>
          {!!description && (
            <Copy style={styles.description}>{description}</Copy>
          )}
          <View style={styles.facts}>
            {item && <Copy style={styles.fact}>{actionLabel(item)}</Copy>}
            {item?.timing.closesAt && (
              <Copy style={styles.fact}>
                Closes {clock(item.timing.closesAt, timezone)}
              </Copy>
            )}
            {item ? (
              <Copy style={styles.fact}>{travelLabel(item)}</Copy>
            ) : (
              place && (
                <Copy style={styles.fact}>{priceLabel(place.price)}</Copy>
              )
            )}
          </View>
          {item && <RequiredNotes item={item} light />}
        </View>
        <View style={styles.rail}>
          <Rail
            name="bookmark"
            label={saved ? "Saved" : "Save"}
            accessibilityLabel={
              saved ? "Remove activity from saved" : "Save activity"
            }
            selected={saved}
            disabled={saveDisabled}
            onPress={onSave}
          />
          <Rail
            name="navigation"
            label="Maps"
            accessibilityLabel="Open in maps"
            disabled={mapsDisabled}
            onPress={onMaps}
          />
          {onNext && (
            <Rail
              name="arrow-right"
              label="Next"
              accessibilityLabel="Next activity"
              onPress={onNext}
            />
          )}
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Read activity details"
        onPress={onDetails}
        style={styles.peek}
      >
        <Copy style={styles.peekText}>The details, and what people say</Copy>
        <Icon name="arrow-down" size={17} color="#D7E2D3" />
      </Pressable>
    </View>
  );
}
function Rail({
  name,
  label,
  accessibilityLabel,
  selected,
  disabled,
  onPress,
}: {
  name: IconName;
  label: string;
  accessibilityLabel: string;
  selected?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.railButton,
        selected && { backgroundColor: "#E5EDDF" },
        disabled && { opacity: 0.45 },
      ]}
    >
      <Icon name={name} color={selected ? "#3D614C" : "#FFFFFF"} />
      <Copy
        maxFontSizeMultiplier={1.4}
        style={[styles.railLabel, selected && { color: "#3D614C" }]}
      >
        {label}
      </Copy>
    </Pressable>
  );
}
const styles = StyleSheet.create({
  hero: {
    backgroundColor: "#27392D",
    paddingHorizontal: 24,
    paddingBottom: 20,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 24,
  },
  headerButton: { minWidth: 44, minHeight: 44, justifyContent: "center" },
  logo: {
    fontSize: 21,
    lineHeight: 27,
    fontWeight: "700",
    color: "white",
    letterSpacing: -0.7,
  },
  area: {
    fontSize: 12,
    lineHeight: 18,
    color: "#F7F5EF",
    textAlign: "right",
    maxWidth: "58%",
  },
  caption: { color: "#F7F5EF", fontSize: 12, lineHeight: 18, marginTop: 10 },
  counter: {
    color: "white",
    fontSize: 12,
    lineHeight: 18,
    padding: 8,
    backgroundColor: "#20302588",
    borderRadius: 15,
    alignSelf: "flex-end",
    marginTop: 20,
  },
  spacer: { flex: 1, minHeight: 128 },
  bottom: {
    flexDirection: "row",
    gap: 16,
    alignItems: "center",
    marginTop: 12,
  },
  copy: { flex: 1, gap: 12, minWidth: 0 },
  kind: { color: "#CCD8C8", fontSize: 13, lineHeight: 18, fontWeight: "500" },
  title: {
    fontSize: 28,
    lineHeight: 32,
    letterSpacing: -0.6,
    fontWeight: "600",
    color: "white",
  },
  description: { color: "#F2F2E8", fontSize: 15, lineHeight: 22 },
  facts: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  fact: {
    fontSize: 13,
    lineHeight: 19,
    color: "#F7F5EF",
    borderWidth: 1,
    borderColor: "#D6DFD944",
    borderRadius: 9,
    paddingVertical: 5,
    paddingHorizontal: 8,
    backgroundColor: "#14251d55",
  },
  dots: { flexDirection: "row", marginLeft: -12 },
  dotHit: {
    height: 44,
    width: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  dot: { height: 6, width: 6, borderRadius: 8, backgroundColor: "#FFFFFF88" },
  dotSelected: { width: 22, backgroundColor: "white" },
  rail: { width: 52, gap: 13 },
  railButton: {
    width: 52,
    minHeight: 63,
    borderRadius: 20,
    paddingVertical: 10,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: "#1c2c2388",
  },
  railLabel: {
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "500",
    color: "white",
  },
  peek: {
    minHeight: 44,
    marginTop: 24,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 9,
  },
  peekText: { fontSize: 13, lineHeight: 19, color: "#D7E2D3" },
  artCircle: {
    width: 240,
    height: 240,
    borderRadius: 120,
    backgroundColor: "#9DAA8C",
    position: "absolute",
    top: 110,
    right: -60,
  },
  artArch: {
    position: "absolute",
    left: 38,
    top: 170,
    width: 158,
    height: 255,
    borderTopLeftRadius: 100,
    borderTopRightRadius: 100,
    backgroundColor: "#263F35",
    alignItems: "center",
    justifyContent: "center",
  },
});
