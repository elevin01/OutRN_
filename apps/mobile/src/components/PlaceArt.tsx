import { StyleSheet, View } from "react-native";
import { Copy, Icon, colors, type IconName } from "./ui";
/** Decorative category artwork, never a photograph or map of a real venue. */
export function PlaceArt({
  category,
  compact = false,
}: {
  category: string;
  compact?: boolean;
}) {
  const nature = /park|garden|waterfront|viewpoint/.test(category);
  const culture = /book|museum|gallery|library|arts|theatre/.test(category);
  const icon: IconName = nature
    ? "sun"
    : culture
      ? "book-open"
      : /bar|nightclub|music/.test(category)
        ? "music"
        : "coffee";
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.art,
        {
          backgroundColor: nature ? "#CCD9BF" : culture ? "#DBD8ED" : "#F0CCAA",
        },
        compact && styles.compact,
      ]}
    >
      <View
        style={[
          styles.circle,
          compact && { width: 68, height: 68, right: -18, top: -15 },
        ]}
      />
      <View
        style={[
          styles.arch,
          compact && { width: 46, height: 64, left: 12, top: 18 },
        ]}
      >
        <Icon name={icon} size={compact ? 25 : 62} color={colors.ink} />
      </View>
      {!compact && (
        <>
          <View style={styles.line} />
          <Copy style={styles.caption}>A little change of scenery.</Copy>
          <Copy style={styles.number}>OUT / RN</Copy>
        </>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  art: { height: 184, overflow: "hidden", position: "relative" },
  compact: { width: 78, height: 90, borderRadius: 16 },
  circle: {
    position: "absolute",
    width: 180,
    height: 180,
    backgroundColor: "#FFF8E9",
    borderRadius: 100,
    top: -80,
    right: -22,
  },
  arch: {
    position: "absolute",
    width: 100,
    height: 154,
    top: 37,
    left: 24,
    borderTopLeftRadius: 65,
    borderTopRightRadius: 65,
    backgroundColor: "rgba(255,255,255,0.42)",
    justifyContent: "center",
    alignItems: "center",
  },
  line: {
    position: "absolute",
    right: 26,
    top: 60,
    height: 60,
    width: 60,
    borderWidth: 1,
    borderColor: colors.ink,
    borderRadius: 40,
  },
  caption: {
    position: "absolute",
    right: 20,
    bottom: 29,
    width: "42%",
    fontSize: 16,
    lineHeight: 21,
    fontWeight: "600",
  },
  number: {
    position: "absolute",
    top: 16,
    left: 20,
    fontSize: 10,
    letterSpacing: 2,
  },
});
