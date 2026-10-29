import { useCallback, useMemo, useState } from "react";
import { Image, StyleSheet, View, type ImageSourcePropType } from "react-native";
import type { RecommendationItem } from "@outrn/contracts";
import { photosFor, photosToShow, type ShownPhoto } from "../lib/photos";
import { representativePhotos } from "../lib/representative";
import { Copy, colors } from "./ui";
import { PlaceArt } from "./PlaceArt";

/**
 * A card's picture, as the place's screen chooses it: its own photo; else an aerial view of its spot
 * or a representative photo of its kind, each labelled as what it is. A photo that fails to load
 * gives way to the next; the category's artwork shows only when none loads.
 */
export function useCardPhoto(item: RecommendationItem): { current: ShownPhoto<ImageSourcePropType> | undefined; fail: (key: string) => void } {
  const representative = representativePhotos(item.category.id, item.cuisines);
  const standIn = useMemo(() => ({ aerial: item.aerial, categoryId: item.category.id }), [item.aerial, item.category.id]);
  const photos = useMemo(
    () => photosFor(item.name, item.category.label, item.photos, representative, (uri) => ({ uri }), standIn),
    [item.name, item.category.label, item.photos, representative, standIn],
  );
  const fallback = useMemo(
    () => photosFor(item.name, item.category.label, undefined, representative, (uri) => ({ uri }), standIn),
    [item.name, item.category.label, representative, standIn],
  );
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const fail = useCallback((key: string) => setFailed((f) => (f.has(key) ? f : new Set([...f, key]))), []);
  return { current: photosToShow(photos, fallback, failed)[0], fail };
}

/** What a stand-in is, on the picture itself: the place's own photo needs no badge. */
const BADGE: Partial<Record<ShownPhoto["kind"], string>> = { aerial: "Aerial view", representative: "Representative" };

export function CardPhoto({
  item,
  photo,
  onFail,
  compact = false,
}: {
  item: RecommendationItem;
  photo: ShownPhoto<ImageSourcePropType> | undefined;
  onFail: (key: string) => void;
  compact?: boolean;
}) {
  if (!photo) return <PlaceArt category={item.category.id} compact={compact} />;
  const badge = BADGE[photo.kind];
  return (
    <View style={compact ? styles.compact : styles.featured} accessible accessibilityRole="image" accessibilityLabel={photo.alt}>
      <Image source={photo.source} style={StyleSheet.absoluteFill} resizeMode="cover" onError={() => onFail(photo.key)} />
      {badge && <Copy style={[styles.badge, compact && styles.badgeCompact]}>{badge}</Copy>}
    </View>
  );
}

/** The credit the photo's license asks for, in a line under the card's title. */
export function cardPhotoCredit(photo: ShownPhoto | undefined): string | null {
  if (!photo) return null;
  return `${photo.kind === "representative" ? "Representative photo" : photo.kind === "aerial" ? "Aerial photo" : "Photo"}: ${photo.credit}`;
}

const styles = StyleSheet.create({
  featured: { height: 184, overflow: "hidden", backgroundColor: colors.sage },
  compact: { width: 78, height: 90, borderRadius: 16, overflow: "hidden", backgroundColor: colors.sage },
  badge: {
    position: "absolute",
    left: 12,
    bottom: 10,
    fontSize: 11,
    lineHeight: 15,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 7,
    overflow: "hidden",
    color: "#FFFFFF",
    backgroundColor: "rgba(20,20,20,0.6)",
  },
  badgeCompact: { left: 5, bottom: 5, fontSize: 9, lineHeight: 12, paddingHorizontal: 4 },
});
