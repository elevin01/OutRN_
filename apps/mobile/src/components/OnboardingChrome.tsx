import { useEffect, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type ImageSourcePropType,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Copy, Icon, colors } from "./ui";
import { isPicked, type InterestChoice, type Taste } from "../lib/onboarding";
import { demoMode } from "../lib/api";

export const interestPhotos: Record<string, ImageSourcePropType> = {
  food: require("../../assets/onboarding/food.jpg"),
  coffee: require("../../assets/onboarding/coffee.jpg"),
  walk: require("../../assets/onboarding/walk.jpg"),
  pub: require("../../assets/onboarding/pub.jpg"),
  art: require("../../assets/onboarding/art.jpg"),
  music: require("../../assets/onboarding/music.jpg"),
  games: require("../../assets/onboarding/games.jpg"),
  market: require("../../assets/onboarding/market.jpg"),
};

export function OnboardingChrome({
  children,
  step,
  back,
  footer,
  photo = "walk",
  spacious = false,
}: {
  children: ReactNode;
  step?: string;
  back?: () => void;
  footer?: ReactNode;
  photo?: string;
  spacious?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  return (
    <View style={styles.screen}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.scroll,
          {
            paddingTop: insets.top,
            paddingBottom: Math.max(insets.bottom, 16),
          },
        ]}
      >
        <View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            styles.atmosphere,
            { height: (spacious ? 370 : 270) + insets.top },
          ]}
        >
          <Image
            source={interestPhotos[photo] || interestPhotos.walk}
            style={[StyleSheet.absoluteFill, { width: "100%", height: "100%" }]}
            resizeMode="cover"
            accessible={false}
          />
          <LinearGradient
            colors={
              spacious
                ? ["#F7F5EFBD", "#F7F5EFA8", "#F7F5EFF2", colors.paper]
                : ["#F7F5EFBD", "#F7F5EFE3", colors.paper]
            }
            locations={spacious ? [0, 0.24, 0.77, 1] : [0, 0.57, 1]}
            style={StyleSheet.absoluteFill}
          />
        </View>
        <View
          style={[styles.content, { paddingHorizontal: width < 360 ? 16 : 24 }]}
        >
          <View style={styles.header}>
            {back ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Back"
                onPress={back}
                style={styles.back}
              >
                <Icon name="arrow-left" size={21} />
              </Pressable>
            ) : (
              <View style={styles.back} />
            )}
            <Copy style={styles.brand}>
              OutRN<Copy style={styles.brandArrow}>↗</Copy>
            </Copy>
            <Copy style={styles.step}>{step}</Copy>
          </View>
          {demoMode && (
            <Copy style={styles.demo}>
              DEMO · Invented places and fixed example times
            </Copy>
          )}
          {children}
          {footer && <View style={styles.footer}>{footer}</View>}
        </View>
      </ScrollView>
    </View>
  );
}

export function OnboardingIntro({
  title,
  children,
  spacious = false,
}: {
  title: string;
  children?: ReactNode;
  spacious?: boolean;
}) {
  return (
    <View style={[styles.intro, spacious && styles.spaciousIntro]}>
      <Copy accessibilityRole="header" style={styles.title}>
        {title}
      </Copy>
      {children && <Copy style={styles.subtitle}>{children}</Copy>}
    </View>
  );
}

export function FirstPickLoading() {
  return (
    <OnboardingChrome>
      <OnboardingIntro title={"Finding your\nkind of nearby."}>
        Checking what works right now.
      </OnboardingIntro>
      <View
        accessibilityRole="progressbar"
        accessibilityLabel="Finding your first recommendations"
        style={{
          backgroundColor: colors.sage,
          minHeight: 295,
          borderRadius: 24,
          marginTop: 28,
          justifyContent: "center",
        }}
      >
        <ActivityIndicator color={colors.green} />
      </View>
    </OnboardingChrome>
  );
}

export function InterestPicker({
  choices,
  taste,
  onToggle,
  fillSpace = false,
}: {
  choices: InterestChoice[];
  taste: Taste;
  onToggle: (choice: InterestChoice) => void;
  fillSpace?: boolean;
}) {
  const { fontScale, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const tileHeight = fillSpace
    ? Math.max(
        90,
        Math.min(112, (height - insets.top - insets.bottom - 370) / 4),
      )
    : 90;
  const [reduceMotion, setReduceMotion] = useState(true);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (active) setReduceMotion(value);
    });
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduceMotion,
    );
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  return (
    <View style={styles.grid}>
      {choices.map((choice) => (
        <InterestTile
          key={choice.id}
          choice={choice}
          selected={isPicked(taste, choice)}
          onPress={() => onToggle(choice)}
          reduceMotion={reduceMotion}
          largeText={fontScale >= 1.5}
          tileHeight={tileHeight}
        />
      ))}
    </View>
  );
}

function InterestTile({
  choice,
  selected,
  onPress,
  reduceMotion,
  largeText,
  tileHeight,
}: {
  choice: InterestChoice;
  selected: boolean;
  onPress: () => void;
  reduceMotion: boolean;
  largeText: boolean;
  tileHeight: number;
}) {
  const [scale] = useState(() => new Animated.Value(1));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (reduceMotion) {
      scale.setValue(1);
      return;
    }
    const motion = Animated.timing(scale, {
      toValue: selected ? 1.04 : 1,
      duration: 180,
      useNativeDriver: true,
    });
    motion.start();
    return () => motion.stop();
  }, [selected, reduceMotion, scale]);
  const source = choice.photo && interestPhotos[choice.photo];
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={choice.label}
      aria-checked={selected}
      onPress={onPress}
      style={[
        styles.tileBorder,
        largeText && styles.wideTile,
        selected && styles.selectedTile,
      ]}
    >
      <View style={[styles.tile, { minHeight: tileHeight }]}>
        {source && !failed && (
          <Animated.Image
            source={source}
            resizeMode="cover"
            onError={() => setFailed(true)}
            accessible={false}
            style={[
              StyleSheet.absoluteFill,
              { width: "100%", height: "100%", transform: [{ scale }] },
            ]}
          />
        )}
        <LinearGradient
          colors={["#14251D05", "#14251D55", "#14251DF0"]}
          locations={[0.1, 0.47, 1]}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        <View style={[styles.selection, selected && styles.selectedMark]}>
          <Icon
            name={selected ? "check" : "plus"}
            size={15}
            color={selected ? colors.ink : colors.paper}
          />
        </View>
        <Copy style={styles.tileLabel}>{choice.label}</Copy>
      </View>
    </Pressable>
  );
}

export const onboardingStyles = StyleSheet.create({
  note: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 18,
    textAlign: "center",
  },
  error: {
    color: colors.accent,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
  },
  centered: {
    textAlign: "center",
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19,
  },
});

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  scroll: { flexGrow: 1 },
  content: { flexGrow: 1, width: "100%", maxWidth: 520, alignSelf: "center" },
  atmosphere: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 48,
    justifyContent: "space-between",
  },
  back: { width: 48, minHeight: 48, justifyContent: "center" },
  brand: {
    fontSize: 21,
    lineHeight: 27,
    fontWeight: "700",
    letterSpacing: -0.7,
  },
  brandArrow: {
    fontSize: 21,
    lineHeight: 27,
    color: colors.signal,
    fontWeight: "700",
  },
  step: {
    width: 48,
    textAlign: "right",
    fontSize: 12,
    lineHeight: 18,
    color: colors.muted,
  },
  intro: { alignItems: "center", marginTop: 16, gap: 9 },
  spaciousIntro: { marginTop: 100 },
  title: {
    fontSize: 28,
    lineHeight: 32,
    fontWeight: "600",
    letterSpacing: -0.7,
    textAlign: "center",
  },
  subtitle: {
    fontSize: 13,
    lineHeight: 19,
    color: colors.muted,
    textAlign: "center",
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 21,
    marginHorizontal: -2,
  },
  tileBorder: {
    width: "48%",
    flexGrow: 1,
    borderWidth: 2,
    borderColor: "transparent",
    borderRadius: 20,
    padding: 0,
  },
  wideTile: { width: "100%" },
  selectedTile: { borderColor: colors.signal },
  tile: {
    borderRadius: 17,
    overflow: "hidden",
    minHeight: 90,
    justifyContent: "flex-end",
    backgroundColor: colors.green,
  },
  tileLabel: {
    color: colors.paper,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
    marginTop: 40,
    paddingHorizontal: 11,
    paddingBottom: 10,
  },
  selection: {
    position: "absolute",
    top: 8,
    right: 8,
    width: 23,
    height: 23,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#F7F5EF80",
    backgroundColor: "#17261D70",
    justifyContent: "center",
    alignItems: "center",
  },
  selectedMark: { backgroundColor: colors.signal, borderColor: colors.signal },
  footer: { marginTop: "auto", paddingTop: 22, gap: 9 },
  demo: {
    fontSize: 11,
    lineHeight: 16,
    textAlign: "center",
    color: colors.accent,
    marginTop: 4,
  },
});
