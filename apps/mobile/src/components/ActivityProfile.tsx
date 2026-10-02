import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type ImageSourcePropType,
} from "react-native";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { PlaceDetails, RecommendationItem } from "@outrn/contracts";
import { Copy, Icon, type IconName } from "./ui";
import { RequiredNotes } from "./PlaceCard";
import {
  actionLabel,
  clock,
  priceLabel,
  safeExternalUrl,
  travelLabel,
} from "../lib/presentation";
import { demoMode } from "../lib/api";
import { categoryIcon } from "../lib/categories";
import { photosToShow, type ShownPhoto } from "../lib/photos";

export function ActivityProfile({
  item,
  place,
  name,
  category,
  area,
  timezone,
  photos = [],
  fallback = [],
  strip,
  height,
  saved,
  saveDisabled,
  mapsDisabled,
  onSave,
  onMaps,
  onNext,
  onDetails,
  onBack,
}: {
  item?: RecommendationItem;
  place?: PlaceDetails;
  name: string;
  category: string;
  area: string;
  timezone: string;
  /** The place's photos, or representative ones when it has none. */
  photos?: ShownPhoto<ImageSourcePropType>[];
  /** Representative photos, shown (labelled) when none of the place's own loads. */
  fallback?: ShownPhoto<ImageSourcePropType>[];
  /** Category shortcuts, under the header. */
  strip?: ReactNode;
  height: number;
  saved: boolean;
  saveDisabled: boolean;
  mapsDisabled: boolean;
  onSave: () => void;
  onMaps: () => void;
  onNext?: () => void;
  onDetails: () => void;
  onBack?: () => void;
}) {
  const [photo, setPhoto] = useState(0);
  const [photoWidth, setPhotoWidth] = useState(0);
  const pager = useRef<ScrollView>(null);
  const currentPhoto = useRef(0);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const fail = (key: string) =>
    setFailed((f) => (f.has(key) ? f : new Set(f).add(key)));
  // A photo that fails to load drops out. When none of the place's own is left, the representative
  // ones (labelled as such); when none of those loads either, no photo: never the category's icon.
  const shown = photosToShow(photos, fallback, failed);
  const current = shown[Math.min(photo, Math.max(0, shown.length - 1))];
  const credit = current?.creditUrl ? safeExternalUrl(current.creditUrl) : undefined;
  const inset = useSafeAreaInsets();
  // Keep the selected page aligned after a resize or a change in photo count.
  useEffect(() => {
    const index = Math.min(
      currentPhoto.current,
      Math.max(0, shown.length - 1),
    );
    currentPhoto.current = index;
    setPhoto(index);
    pager.current?.scrollTo({ x: index * photoWidth, animated: false });
  }, [photoWidth, shown.length]);
  const selectPhoto = (index: number) => {
    currentPhoto.current = index;
    setPhoto(index);
    pager.current?.scrollTo({ x: index * photoWidth, animated: true });
  };
  const categoryId = item?.category.id || place?.category.id || "";
  // An event's admission price can differ from the venue's usual price.
  const price = item?.price ?? place?.price;
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
    >
      {shown.length > 1 ? (
        <ScrollView
          ref={pager}
          testID="activity-photo-pager"
          horizontal
          pagingEnabled
          directionalLockEnabled
          nestedScrollEnabled
          bounces={false}
          showsHorizontalScrollIndicator={false}
          contentInsetAdjustmentBehavior="never"
          style={StyleSheet.absoluteFill}
          contentContainerStyle={styles.photoStrip}
          onLayout={(e) => setPhotoWidth(e.nativeEvent.layout.width)}
          scrollEventThrottle={16}
          onScroll={(e) => {
            const width = e.nativeEvent.layoutMeasurement.width;
            // A resize can emit a scroll before the photo widths catch up.
            if (!width || Math.abs(width - photoWidth) > 1) return;
            const index = Math.max(
              0,
              Math.min(
                shown.length - 1,
                Math.round(e.nativeEvent.contentOffset.x / width),
              ),
            );
            currentPhoto.current = index;
            setPhoto(index);
          }}
        >
          {shown.map((p, index) => (
            <Image
              key={p.key}
              testID={index === photo ? "activity-photo" : undefined}
              source={p.source}
              style={{ width: photoWidth, height: "100%" }}
              resizeMode="cover"
              accessibilityLabel={p.alt}
              onError={() => fail(p.key)}
            />
          ))}
        </ScrollView>
      ) : current ? (
        <Image
          testID="activity-photo"
          source={current.source}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          accessibilityLabel={current.alt}
          onError={() => fail(current.key)}
        />
      ) : null}
      <LinearGradient
        pointerEvents="none"
        colors={["#101b1455", "#101b1400", "#14281cbb", "#14281cf5"]}
        locations={[0, 0.27, 0.64, 1]}
        style={StyleSheet.absoluteFill}
      />
      {/* Static overlays pass swipes through; buttons keep their hit targets. */}
      <View pointerEvents="box-none" style={styles.header}>
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
          <Copy pointerEvents="none" style={styles.logo}>
            OutRN<Copy style={{ color: "#F36B3F" }}>↗</Copy>
          </Copy>
        )}
        <Copy pointerEvents="none" style={styles.area}>
          {area}
        </Copy>
      </View>
      {strip}
      <Copy pointerEvents="none" style={styles.caption}>
        {demoMode
          ? "Demo places · illustrative photos and posts"
          : current?.kind === "representative"
            ? "Representative photo · not this place"
            : ""}
      </Copy>
      {shown.length > 1 && (
        <Copy pointerEvents="none" style={styles.counter}>
          {Math.min(photo, shown.length - 1) + 1} / {shown.length}
        </Copy>
      )}
      <View pointerEvents="none" style={styles.spacer} />
      <View pointerEvents="box-none" style={styles.bottom}>
        <View pointerEvents="box-none" style={styles.copy}>
          {shown.length > 1 && (
            <View pointerEvents="box-none" style={styles.dots}>
              {shown.map((_, i) => (
                <Pressable
                  key={i}
                  accessibilityRole="button"
                  accessibilityLabel={`Show photo ${i + 1}`}
                  accessibilityState={{ selected: photo === i }}
                  onPress={() => selectPhoto(i)}
                  style={styles.dotHit}
                >
                  <View
                    style={[styles.dot, i === photo && styles.dotSelected]}
                  />
                </Pressable>
              ))}
            </View>
          )}
          <View pointerEvents="none" style={styles.kindRow}>
            <MaterialCommunityIcons
              name={categoryIcon(categoryId)}
              size={16}
              color="#F7F5EF"
              accessible={false}
            />
            <Copy testID="activity-summary" style={styles.kind}>
              {category}
              {price ? ` · ${priceLabel(price)}` : ""}
            </Copy>
          </View>
          <Copy accessibilityRole="header" style={styles.title}>
            {name}
          </Copy>
          {!!description && (
            <Copy style={styles.description}>{description}</Copy>
          )}
          {item && (
            <View style={styles.facts}>
              <Copy style={styles.fact}>{actionLabel(item)}</Copy>
              {item.timing.closesAt && (
                <Copy style={styles.fact}>
                  Closes {clock(item.timing.closesAt, timezone)}
                </Copy>
              )}
              <Copy style={styles.fact}>{travelLabel(item)}</Copy>
            </View>
          )}
          {item && <RequiredNotes item={item} light />}
          {current && (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={`Photo credit: ${current.credit}`}
              disabled={!credit}
              onPress={() => credit && void Linking.openURL(credit).catch(() => undefined)}
              style={styles.creditHit}
            >
              <Copy style={styles.credit} numberOfLines={2}>
                {current.kind === "representative" ? "Representative photo" : "Photo"}: {current.credit}
              </Copy>
            </Pressable>
          )}
        </View>
        <View pointerEvents="box-none" style={styles.rail}>
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
  photoStrip: { height: "100%" },
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
  kindRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  creditHit: { minHeight: 32, justifyContent: "center", marginTop: 4 },
  credit: { color: "#D7E2D3", fontSize: 11, lineHeight: 16 },
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
  kind: {
    pointerEvents: "none",
    color: "#CCD8C8",
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "500",
  },
  title: {
    pointerEvents: "none",
    fontSize: 28,
    lineHeight: 32,
    letterSpacing: -0.6,
    fontWeight: "600",
    color: "white",
  },
  description: {
    pointerEvents: "none",
    color: "#F2F2E8",
    fontSize: 15,
    lineHeight: 22,
  },
  facts: {
    pointerEvents: "none",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 7,
  },
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
});
