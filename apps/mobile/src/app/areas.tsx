import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { router } from "expo-router";
import { useApp } from "../state/app";
import {
  Copy,
  Heading,
  Icon,
  IconButton,
  Problem,
  Row,
  Screen,
  colors,
  s,
} from "../components/ui";
export default function AreasScreen() {
  const { areas, query, search, initialize } = useApp();
  const [term, setTerm] = useState("");
  const matches = areas?.areas.filter((a) =>
    a.name.toLowerCase().includes(term.toLowerCase()),
  );
  return (
    <Screen>
      <Row style={s.between}>
        <Heading>Where to?</Heading>
        <IconButton
          name="x"
          label="Close area selection"
          onPress={() => router.back()}
        />
      </Row>
      <Copy style={s.muted}>
        Choose a supported area. Travel estimates start from its center.
      </Copy>
      <TextInput
        accessibilityLabel="Search areas"
        placeholder="Search areas"
        placeholderTextColor={colors.muted}
        value={term}
        onChangeText={setTerm}
        autoCorrect={false}
        style={{
          padding: 16,
          minHeight: 52,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface,
          color: colors.ink,
          fontFamily: "DMSans",
          fontSize: 16,
          borderRadius: 16,
        }}
      />
      {!areas ? (
        <Problem
          message="The available areas haven’t loaded yet."
          retry={() => void initialize()}
        />
      ) : matches?.length ? (
        matches.map((area) => (
          <Pressable
            key={area.id}
            accessibilityRole="button"
            accessibilityState={{ selected: area.id === query?.areaId }}
            onPress={() => {
              const next = {
                ...query,
                areaId: area.id,
                windowMinutes:
                  query?.windowMinutes || areas.filters.defaultWindowMinutes,
                travelMode: undefined,
              };
              void search(next, next);
              router.back();
            }}
            style={{
              paddingVertical: 18,
              borderBottomWidth: 1,
              borderColor: colors.border,
            }}
          >
            <Row>
              <Icon name="map-pin" />
              <View style={{ flex: 1 }}>
                <Copy style={{ fontWeight: "600" }}>{area.name}</Copy>
                <Copy style={[s.muted, { fontSize: 13 }]}>
                  {area.defaultTravelMode} from the area center
                </Copy>
              </View>
              {area.id === query?.areaId && (
                <Icon name="check" color={colors.green} />
              )}
            </Row>
          </Pressable>
        ))
      ) : (
        <Copy>No supported areas match “{term}”. Try another name.</Copy>
      )}
    </Screen>
  );
}
