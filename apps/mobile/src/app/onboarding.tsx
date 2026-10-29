import { useEffect, useRef, useState } from "react";
import {
  BackHandler,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { useApp } from "../state/app";
import {
  Button,
  Copy,
  Icon,
  Loading,
  colors,
  type IconName,
} from "../components/ui";
import {
  InterestPicker,
  OnboardingChrome,
  OnboardingIntro,
  onboardingStyles as shared,
} from "../components/OnboardingChrome";
import {
  interestChoices,
  isPicked,
  nearestArea,
  toggleChoice,
  type Setup,
} from "../lib/onboarding";
import { deviceOrigin } from "../lib/device-location";
import { LocationProblem } from "../lib/location-request";

const modeIcons: Record<string, IconName> = {
  walk: "navigation",
  drive: "truck",
  transit: "map",
};
export default function OnboardingScreen() {
  const {
    areas,
    busy,
    error,
    initialize,
    taste,
    setup,
    setupNotice,
    storageError,
    updatePreferences,
    completeSetup,
  } = useApp();
  const [term, setTerm] = useState("");
  const [locationNotice, setLocationNotice] = useState<string>();
  const [locating, setLocating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const step = setup.step;
  const choices = interestChoices(areas?.filters.interests || []);
  const chosenPhoto =
    choices.find((choice) => isPicked(taste, choice))?.photo || "food";
  const modes = areas?.filters.travelModes || [];
  const mode =
    modes.find((entry) => entry.id === setup.travelMode)?.id ||
    modes.find((entry) => entry.id === "walk")?.id ||
    modes[0]?.id;
  function cancelLocation() {
    controller.current?.abort();
    controller.current = null;
    setLocating(false);
  }
  function move(step: Setup["step"]) {
    if (submitting) return;
    cancelLocation();
    void updatePreferences({
      setup: { ...setup, step },
      ...(step === "nearby" ? { taste: { ...taste, asked: true } } : {}),
    });
  }
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        if (submitting) return true;
        if (step !== "interests") {
          move(step === "area" ? "nearby" : "interests");
          return true;
        }
        return false;
      },
    );
    return () => subscription.remove();
  });
  async function chooseArea(areaId: string) {
    if (submitting) return;
    cancelLocation();
    setSubmitting(true);
    await completeSetup(areaId, mode);
    setSubmitting(false);
  }
  async function locate() {
    if (locating || submitting || !areas?.areas.length) return;
    const attempt = new AbortController();
    controller.current?.abort();
    controller.current = attempt;
    setLocating(true);
    setLocationNotice(undefined);
    try {
      const origin = await deviceOrigin(true, attempt.signal);
      if (attempt.signal.aborted) return;
      const area = nearestArea(areas.areas, origin);
      if (!area) return;
      setSubmitting(true);
      await completeSetup(area.id, mode, origin);
    } catch (failure) {
      if (attempt.signal.aborted) return;
      setLocationNotice(
        failure instanceof LocationProblem
          ? failure.message
          : "Choose a starting area instead.",
      );
      void updatePreferences({ setup: { ...setup, step: "area" } });
    } finally {
      if (controller.current === attempt) {
        setLocating(false);
        setSubmitting(false);
      }
    }
  }
  const notices = (
    <>
      {(locationNotice || setupNotice) && (
        <Copy accessibilityRole="alert" style={shared.error}>
          {locationNotice || setupNotice}
        </Copy>
      )}
      {storageError && (
        <Copy accessibilityRole="alert" style={shared.error}>
          {storageError}
        </Copy>
      )}
    </>
  );
  if (!areas?.areas.length)
    return (
      <OnboardingChrome>
        <OnboardingIntro
          title={
            busy
              ? "Finding your\nkind of nearby."
              : error
                ? "A little pause."
                : "More places soon."
          }
        >
          {error
            ? "Your choices are still here."
            : !busy
              ? "We’re getting the first areas ready."
              : undefined}
        </OnboardingIntro>
        {busy ? (
          <Loading label="Getting things ready…" />
        ) : (
          <View style={styles.recovery}>
            {error && (
              <Copy accessibilityRole="alert" style={shared.centered}>
                {error.message}
              </Copy>
            )}
            <Button label="Try again" onPress={() => void initialize()} />
          </View>
        )}
        {notices}
      </OnboardingChrome>
    );
  if (step === "interests")
    return (
      <OnboardingChrome
        step="1 of 2"
        footer={
          <>
            <Button
              label={
                choices.some((choice) => isPicked(taste, choice))
                  ? "Find my spots"
                  : "Surprise me"
              }
              icon="arrow-right"
              onPress={() => move("nearby")}
            />
            <Copy style={shared.note}>You can change these anytime.</Copy>
            {notices}
          </>
        }
      >
        <OnboardingIntro title={"Let’s find your\nkind of out."}>
          Pick a few. We’ll take it from here.
        </OnboardingIntro>
        <InterestPicker
          fillSpace
          choices={choices}
          taste={taste}
          onToggle={(choice) => {
            void updatePreferences({ taste: toggleChoice(taste, choice) });
          }}
        />
      </OnboardingChrome>
    );
  if (step === "area") {
    const matches = areas.areas.filter((area) =>
      area.name.toLocaleLowerCase().includes(term.trim().toLocaleLowerCase()),
    );
    return (
      <OnboardingChrome
        step="2 of 2"
        back={() => move("nearby")}
        footer={
          <Copy style={shared.note}>
            Travel estimates start from the area center.
          </Copy>
        }
      >
        <OnboardingIntro title={"Pick a place\nto start."}>
          Choose an area we cover.
        </OnboardingIntro>
        <View style={styles.notices}>{notices}</View>
        <View style={styles.search}>
          <Icon name="search" size={19} />
          <TextInput
            accessibilityLabel="Search areas"
            placeholder="City or neighborhood"
            placeholderTextColor={colors.muted}
            value={term}
            onChangeText={setTerm}
            autoCorrect={false}
            style={styles.input}
          />
        </View>
        {matches.map((area) => (
          <Pressable
            key={area.id}
            accessibilityRole="button"
            accessibilityLabel={`Start from ${area.name}`}
            disabled={submitting}
            onPress={() => void chooseArea(area.id)}
            style={styles.area}
          >
            <Icon name="map-pin" size={19} />
            <Copy style={styles.areaName}>{area.name}</Copy>
            <Icon name="arrow-right" size={19} />
          </Pressable>
        ))}
        {!matches.length && (
          <Copy style={shared.centered}>
            No supported areas match “{term}”. Try another name.
          </Copy>
        )}
        {submitting && (
          <Copy accessibilityLiveRegion="polite" style={shared.centered}>
            Saving your starting point…
          </Copy>
        )}
      </OnboardingChrome>
    );
  }
  return (
    <OnboardingChrome
      step="2 of 2"
      back={() => move("interests")}
      photo={chosenPhoto}
      spacious
      footer={
        <>
          <Button
            label={
              locating
                ? "Finding your location…"
                : submitting
                  ? "Getting your picks…"
                  : "Use my location"
            }
            icon="arrow-right"
            onPress={() => void locate()}
            disabled={locating || submitting}
          />
          <Button
            label="Choose an area instead"
            secondary
            onPress={() => move("area")}
            disabled={submitting}
          />
          <Copy style={shared.note}>Only while you’re using the app.</Copy>
          {notices}
        </>
      }
    >
      <OnboardingIntro title={"Now, let’s\nkeep it close."} spacious>
        Where should we look?
      </OnboardingIntro>
      <View style={styles.travel}>
        <Copy style={styles.travelLabel}>How are you getting there?</Copy>
        <View style={styles.modes}>
          {modes.map((entry) => (
            <Pressable
              key={entry.id}
              accessibilityRole="radio"
              accessibilityLabel={entry.label}
              aria-checked={mode === entry.id}
              disabled={locating || submitting}
              onPress={() => {
                void updatePreferences({
                  setup: { ...setup, travelMode: entry.id },
                });
              }}
              style={[styles.mode, mode === entry.id && styles.modeSelected]}
            >
              <Icon
                name={modeIcons[entry.id] || "navigation"}
                size={17}
                color={mode === entry.id ? colors.paper : colors.ink}
              />
              <Copy
                style={[
                  styles.modeLabel,
                  mode === entry.id && { color: colors.paper },
                ]}
              >
                {entry.label}
              </Copy>
            </Pressable>
          ))}
        </View>
        <Copy style={[shared.centered, styles.locationCopy]}>
          Your location helps us find nearby picks{"\n"}and work out the
          journey.
        </Copy>
      </View>
    </OnboardingChrome>
  );
}

const styles = StyleSheet.create({
  recovery: { marginTop: 40, gap: 20 },
  notices: { gap: 10, marginTop: 18 },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    marginTop: 20,
    marginBottom: 12,
  },
  input: {
    flex: 1,
    minWidth: 0,
    minHeight: 54,
    fontFamily: "DMSans",
    fontSize: 16,
    color: colors.ink,
  },
  area: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 20,
    borderBottomWidth: 1,
    borderColor: colors.border,
    minHeight: 64,
  },
  areaName: { flex: 1, fontWeight: "500" },
  travel: { marginTop: 30 },
  travelLabel: {
    textAlign: "center",
    fontSize: 13,
    lineHeight: 19,
    fontWeight: "500",
    marginBottom: 12,
  },
  modes: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  mode: {
    flexGrow: 1,
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    paddingHorizontal: 12,
    minHeight: 46,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 24,
    backgroundColor: colors.surface,
  },
  modeSelected: { backgroundColor: colors.ink, borderColor: colors.ink },
  modeLabel: { fontSize: 13, lineHeight: 19, fontWeight: "500" },
  locationCopy: { marginTop: 22, marginBottom: 25 },
});
