import { useRef } from "react";
import { Pressable, ScrollView, StyleSheet } from "react-native";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import type { CategoryGroup } from "../lib/categories";
import { Copy } from "./ui";

/** One-tap category shortcuts over the activity photo: "All", "Food", "Outdoors", "Movies & shows"… */
export function CategoryStrip({
  groups,
  active,
  disabled,
  onSelect,
}: {
  groups: readonly CategoryGroup[];
  active: string | null;
  disabled?: boolean;
  onSelect: (group: CategoryGroup) => void;
}) {
  // A new search remounts the strip at its start: bring the chosen shortcut back into view.
  const scroll = useRef<ScrollView>(null);
  const shown = useRef(false);
  return (
    <ScrollView
      ref={scroll}
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      style={styles.strip}
      accessibilityRole="tablist"
    >
      {groups.map((g) => {
        const selected = g.id === active;
        return (
          <Pressable
            key={g.id}
            accessibilityRole="tab"
            accessibilityLabel={g.id === "all" ? "Every kind of place" : g.label}
            accessibilityState={{ selected, disabled }}
            disabled={disabled}
            onPress={() => !selected && onSelect(g)}
            onLayout={(e) => {
              if (!selected || shown.current || g.id === "all") return;
              shown.current = true;
              scroll.current?.scrollTo({ x: Math.max(0, e.nativeEvent.layout.x - 24), animated: false });
            }}
            style={[styles.chip, selected && styles.selected, disabled && { opacity: 0.5 }]}
          >
            <MaterialCommunityIcons name={g.icon} size={17} color={selected ? "#20251F" : "#FFFFFF"} accessible={false} />
            <Copy maxFontSizeMultiplier={1.3} style={[styles.label, selected && { color: "#20251F" }]}>
              {g.label}
            </Copy>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  strip: { marginTop: 12, marginHorizontal: -24, flexGrow: 0 },
  row: { gap: 8, paddingHorizontal: 24 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: 18,
    backgroundColor: "#1B2A2066",
    borderWidth: 1,
    borderColor: "#FFFFFF55",
  },
  selected: { backgroundColor: "#F7F5EF", borderColor: "#F7F5EF" },
  label: { color: "#FFFFFF", fontSize: 13, lineHeight: 18, fontWeight: "600" },
});
