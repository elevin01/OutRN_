import { useState } from "react";
import {
  Image,
  Linking,
  Pressable,
  StyleSheet,
  View,
  type ImageSourcePropType,
} from "react-native";
import type { Photo } from "@outrn/contracts";
import { photosFor, photosToShow } from "../lib/photos";
import { representativePhotos } from "../lib/representative";
import { Copy, colors } from "./ui";

/** Uses the same vetted-photo and labelled-fallback policy as the Now screen. */
export function SavedMedia({
  photos,
  category,
  categoryLabel,
  name,
  height = 124,
}: {
  photos?: readonly Photo[];
  category: string;
  categoryLabel: string;
  name: string;
  height?: number;
}) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const [linkError, setLinkError] = useState(false);
  const remote = (uri: string): ImageSourcePropType => ({ uri });
  const own = photosFor(name, categoryLabel, photos, [], remote);
  const fallback = photosFor(
    name,
    categoryLabel,
    undefined,
    representativePhotos(category),
    remote,
  );
  const shown = photosToShow(own, fallback, failed)[0];
  const credit = shown
    ? `${shown.kind === "representative" ? "Representative photo · not this place\n" : ""}${shown.credit}`
    : "";
  return (
    <View>
      <View style={[styles.image, { height }]}>
        {shown ? (
          <Image
            key={shown.key}
            source={shown.source}
            resizeMode="cover"
            style={styles.photo}
            accessibilityLabel={shown.alt}
            onError={() => setFailed((old) => new Set(old).add(shown.key))}
          />
        ) : (
          <View style={styles.noPhoto}>
            <Copy style={styles.credit}>No photo yet</Copy>
          </View>
        )}
      </View>
      {shown &&
        (shown.creditUrl ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={`Photo credit: ${shown.credit}`}
            style={styles.creditLink}
            onPress={(event) => {
              event.stopPropagation();
              setLinkError(false);
              void Linking.openURL(shown.creditUrl!).catch(() =>
                setLinkError(true),
              );
            }}
          >
            <Copy style={styles.credit}>{credit}</Copy>
          </Pressable>
        ) : (
          <Copy style={styles.credit}>{credit}</Copy>
        ))}
      {linkError && (
        <Copy accessibilityRole="alert" style={styles.credit}>
          Couldn’t open photo source. Try again.
        </Copy>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  photo: { width: "100%", height: "100%" },
  image: { overflow: "hidden", borderRadius: 15, backgroundColor: colors.sage },
  noPhoto: { flex: 1, alignItems: "center", justifyContent: "center" },
  creditLink: { minHeight: 44, justifyContent: "center" },
  credit: { fontSize: 11, lineHeight: 15, color: colors.muted, marginTop: 4 },
});
