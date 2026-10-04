import { useState } from "react";
import { TextInput, View } from "react-native";
import { router } from "expo-router";
import type { RecommendationRequest } from "@outrn/contracts";
import { useApp } from "../state/app";
import {
  Button,
  Chip,
  Copy,
  Eyebrow,
  Heading,
  IconButton,
  Row,
  Screen,
  colors,
  s,
} from "../components/ui";
export default function FiltersScreen() {
  const { areas, query, search } = useApp();
  const [draft, setDraft] = useState<RecommendationRequest | undefined>(query);
  const [age, setAge] = useState(query?.youngestAge?.toString() || "");
  if (!areas || !draft)
    return (
      <Screen>
        <Heading>Let’s get connected.</Heading>
        <Copy>Load the available areas before adjusting your plans.</Copy>
        <Button label="Back to Now" onPress={() => router.replace("/")} />
      </Screen>
    );
  const set = (patch: Partial<RecommendationRequest>) =>
    setDraft({ ...draft, ...patch });
  const filters = areas.filters;
  const ageValid =
    age === "" ||
    (/^\d+$/.test(age) &&
      Number(age) >= areas.limits.youngestAge.min &&
      Number(age) <= areas.limits.youngestAge.max);
  const apply = () => {
    const next = {
      ...draft,
      youngestAge: age === "" ? undefined : Number(age),
    };
    void search(next, next);
    router.back();
  };
  return (
    <Screen
      footer={
        <Button
          label="Find my options"
          onPress={apply}
          disabled={!ageValid}
          icon="arrow-right"
        />
      }
    >
      <Row style={s.between}>
        <Eyebrow>Make it your afternoon</Eyebrow>
        <IconButton
          name="x"
          label="Cancel filter changes"
          onPress={() => router.back()}
        />
      </Row>
      <Heading>What fits{"\n"}right now?</Heading>
      <Group title="Time to spare">
        <View style={s.wrap}>
          {filters.windows.map((w) => (
            <Chip
              key={w.minutes}
              label={w.label}
              selected={draft.windowMinutes === w.minutes}
              onPress={() => set({ windowMinutes: w.minutes })}
            />
          ))}
        </View>
      </Group>
      <Group title="Getting there">
        <View style={s.wrap}>
          {filters.travelModes.map((m) => (
            <Chip
              key={m.id}
              label={m.label}
              selected={
                (draft.travelMode ||
                  areas.areas.find((a) => a.id === draft.areaId)
                    ?.defaultTravelMode) === m.id
              }
              onPress={() => set({ travelMode: m.id })}
            />
          ))}
        </View>
      </Group>
      <Group title="Budget per person">
        <View style={s.wrap}>
          {filters.budgets.map((b) => (
            <Chip
              key={b.id}
              label={b.label}
              selected={
                JSON.stringify(draft.budget || { kind: "any" }) ===
                JSON.stringify(b.budget)
              }
              onPress={() => set({ budget: b.budget })}
            />
          ))}
        </View>
      </Group>
      <Group title="In the mood for">
        <View style={s.wrap}>
          <Chip
            label="Anything"
            selected={!draft.mood}
            onPress={() => set({ mood: undefined })}
          />
          {filters.moods.map((m) => (
            <Chip
              key={m.id}
              label={m.label}
              selected={draft.mood === m.id}
              onPress={() => set({ mood: m.id })}
            />
          ))}
        </View>
      </Group>
      <Group title="Who’s coming">
        <View style={s.wrap}>
          <Chip
            label="Any company"
            selected={!draft.company}
            onPress={() => set({ company: undefined })}
          />
          {filters.companies.map((m) => (
            <Chip
              key={m.id}
              label={m.label}
              selected={draft.company === m.id}
              onPress={() => set({ company: m.id })}
            />
          ))}
        </View>
      </Group>
      <Group title="Youngest person’s age (optional)">
        <TextInput
          accessibilityLabel="Youngest person’s age"
          value={age}
          onChangeText={setAge}
          keyboardType="number-pad"
          maxLength={3}
          placeholder="Age"
          placeholderTextColor={colors.muted}
          style={{
            padding: 16,
            borderWidth: 1,
            borderColor: ageValid ? colors.border : colors.accent,
            borderRadius: 16,
            fontFamily: "DMSans",
            fontSize: 16,
            color: colors.ink,
            backgroundColor: colors.surface,
          }}
        />
        {!ageValid && (
          <Copy accessibilityRole="alert">
            Enter an age from {areas.limits.youngestAge.min} to{" "}
            {areas.limits.youngestAge.max}.
          </Copy>
        )}
      </Group>
      <Group
        title={`Places you feel like (up to ${areas.limits.maxCategories})`}
      >
        <View style={s.wrap}>
          {filters.categories.map((c) => {
            const selected = !!draft.categories?.includes(c.id);
            return (
              <Chip
                key={c.id}
                label={c.label}
                selected={selected}
                disabled={
                  !selected &&
                  (draft.categories?.length || 0) >= areas.limits.maxCategories
                }
                onPress={() =>
                  set({
                    categories: selected
                      ? draft.categories?.filter((id) => id !== c.id)
                      : [...(draft.categories || []), c.id],
                  })
                }
              />
            );
          })}
        </View>
        <Copy style={s.muted}>
          Leave these unselected to explore every kind of place.
        </Copy>
      </Group>
      <Button
        label="Reset filters"
        secondary
        onPress={() => {
          setDraft({
            areaId: draft.areaId,
            windowMinutes: filters.defaultWindowMinutes,
            origin: draft.origin,
            travelMode: draft.travelMode,
          });
          setAge("");
        }}
      />
    </Screen>
  );
}
function Group({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={{ gap: 12 }}>
      <Copy accessibilityRole="header" style={{ fontWeight: "700" }}>
        {title}
      </Copy>
      {children}
    </View>
  );
}
