import { Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import type { RecommendationItem } from "@outrn/contracts";
import {
  ageLabel,
  duration,
  priceLabel,
  travelLabel,
} from "../lib/presentation";
import { Copy, Eyebrow, Icon, Row, colors, s } from "./ui";
import { PlaceArt } from "./PlaceArt";
export function RequiredNotes({ item }: { item: RecommendationItem }) {
  const notes = [...item.caveats, ...item.reasons.filter((r) => r.required)];
  return (
    <>
      {item.ageLimit && (
        <Copy style={styles.note}>{ageLabel(item.ageLimit)}</Copy>
      )}
      {notes.map((note, i) => (
        <Copy key={`${note.code}-${i}`} style={styles.note}>
          {note.text}
        </Copy>
      ))}
    </>
  );
}
export function PlaceCard({
  item,
  index,
  featured,
}: {
  item: RecommendationItem;
  index: number;
  featured?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`View ${item.name}`}
      onPress={() =>
        router.push({
          pathname: "/place/[id]",
          params: { id: item.placeId, itemId: item.id },
        })
      }
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.8 }]}
    >
      {featured && <PlaceArt category={item.category.id} />}
      <View style={styles.body}>
        <Row style={s.between}>
          <Eyebrow>
            {String(index + 1).padStart(2, "0")} / {item.category.label}
          </Eyebrow>
          <Copy
            style={[
              styles.status,
              item.status === "check_first" && {
                backgroundColor: colors.warm,
                color: colors.accent,
              },
            ]}
          >
            {item.status === "ready" ? "Ready to go" : "Check first"}
          </Copy>
        </Row>
        <Row>
          <View style={{ flex: 1, gap: 7 }}>
            <Copy
              style={[
                styles.title,
                featured && { fontSize: 26, lineHeight: 31 },
              ]}
            >
              {item.name}
            </Copy>
            <Copy style={s.muted}>
              {travelLabel(item)} · {priceLabel(item.price)}
            </Copy>
            <Copy style={s.muted}>
              {duration(item.timing.usefulMinutes)} to enjoy it
            </Copy>
          </View>
          {!featured && <PlaceArt category={item.category.id} compact />}
        </Row>
        {featured && item.copy.sentence && <Copy>{item.copy.sentence}</Copy>}
        <RequiredNotes item={item} />
        <Row style={s.between}>
          <Copy style={styles.link}>Take a closer look</Copy>
          <Icon name="arrow-up-right" size={19} color={colors.accent} />
        </Row>
      </View>
    </Pressable>
  );
}
const styles = StyleSheet.create({
  card: {
    borderRadius: 24,
    backgroundColor: colors.surface,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#E8E7DF",
  },
  body: { padding: 20, gap: 13 },
  title: {
    fontSize: 20,
    lineHeight: 26,
    fontWeight: "700",
    letterSpacing: -0.5,
  },
  status: {
    fontSize: 11,
    lineHeight: 17,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 9,
    color: colors.green,
    backgroundColor: colors.sage,
  },
  note: { fontSize: 14, lineHeight: 21, color: colors.accent },
  link: { color: colors.accent, fontWeight: "600", fontSize: 14 },
});
