import { Pressable, StyleSheet, View } from "react-native";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import type { RecommendationItem } from "@outrn/contracts";
import { clock } from "../lib/presentation";
import { Copy, Icon } from "./ui";

/**
 * Happening soon, over the activity photo: an event starting within two hours (one this person loves
 * first). Tapping it opens what's on; the cross hides it for this session.
 */
export function HappeningPill({
  item,
  timezone,
  now,
  onOpen,
  onHide,
}: {
  item: RecommendationItem;
  timezone: string;
  /** The screen's clock (ms), ticking. */
  now: number;
  onOpen: () => void;
  onHide: () => void;
}) {
  const starts = item.event ? Date.parse(item.event.startsAt) : NaN;
  const when = Number.isFinite(starts)
    ? starts <= now
      ? "on now"
      : clock(item.event!.startsAt, timezone)
    : "soon";
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Happening soon: ${item.name}, ${when}. See what's on`}
        onPress={onOpen}
        style={({ pressed }) => [styles.pill, pressed && { opacity: 0.75 }]}
      >
        <MaterialCommunityIcons
          name="calendar-star"
          size={17}
          color="#20251F"
          accessible={false}
        />
        <Copy
          maxFontSizeMultiplier={1.3}
          numberOfLines={1}
          style={styles.text}
        >
          <Copy style={styles.lead}>Happening soon · </Copy>
          {item.name} · {when}
        </Copy>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Hide this for now"
        onPress={onHide}
        hitSlop={8}
        style={styles.hide}
      >
        <Icon name="x" size={16} color="#FFFFFF" />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { marginTop: 10, flexDirection: "row", alignItems: "center", gap: 8 },
  pill: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: 18,
    backgroundColor: "#FBE5D9",
  },
  text: { flex: 1, color: "#20251F", fontSize: 13, lineHeight: 18 },
  lead: { color: "#AD361A", fontWeight: "700", fontSize: 13, lineHeight: 18 },
  hide: {
    minWidth: 36,
    minHeight: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 18,
    backgroundColor: "#1B2A2066",
  },
});
