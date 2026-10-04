import { useState } from "react";
import { router } from "expo-router";
import { useApp } from "../state/app";
import { Button, Copy } from "../components/ui";
import {
  InterestPicker,
  OnboardingChrome,
  OnboardingIntro,
  onboardingStyles,
} from "../components/OnboardingChrome";
import { interestChoices, toggleChoice } from "../lib/onboarding";

export default function InterestsScreen() {
  const { taste, areas, saveInterests, storageError } = useApp();
  const [draft, setDraft] = useState(taste);
  const [saving, setSaving] = useState(false);
  return (
    <OnboardingChrome
      back={() => router.back()}
      footer={
        <>
          <Button
            label={saving ? "Saving…" : "Save my interests"}
            disabled={saving}
            onPress={() => {
              setSaving(true);
              void saveInterests(draft)
                .then(() => router.back())
                .finally(() => setSaving(false));
            }}
          />
          <Copy style={onboardingStyles.note}>
            These guide your picks. You can still explore everything.
          </Copy>
          {storageError && (
            <Copy accessibilityRole="alert" style={onboardingStyles.error}>
              {storageError}
            </Copy>
          )}
        </>
      }
    >
      <OnboardingIntro title={"Your kind\nof out."}>
        Pick what you enjoy.
      </OnboardingIntro>
      <InterestPicker
        choices={interestChoices(areas?.filters.interests || [], true)}
        taste={draft}
        onToggle={(choice) =>
          setDraft((current) => toggleChoice(current, choice))
        }
      />
    </OnboardingChrome>
  );
}
