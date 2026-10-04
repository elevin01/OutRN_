import { router } from "expo-router";
import { useApp } from "../../state/app";
import {
  Button,
  Copy,
  Eyebrow,
  Heading,
  Icon,
  Panel,
  Screen,
  s,
} from "../../components/ui";
export default function YouScreen() {
  const { areas, query, outing, storageError } = useApp();
  return (
    <Screen>
      <Heading>You</Heading>
      <Button
        label="What you like"
        secondary
        icon="heart"
        onPress={() => router.push("/interests")}
      />
      {storageError && <Copy accessibilityRole="alert">{storageError}</Copy>}
      {outing && (
        <Button
          label="Your current outing"
          onPress={() => router.push("/outing")}
        />
      )}
      <Panel>
        <Icon name="map-pin" />
        <Eyebrow>Your area</Eyebrow>
        <Copy style={{ fontSize: 20, lineHeight: 26, fontWeight: "600" }}>
          {areas?.areas.find((a) => a.id === query?.areaId)?.name ||
            "Choose an area"}
        </Copy>
        <Button
          label="Change area"
          secondary
          onPress={() => router.push("/areas")}
        />
      </Panel>
      <Button
        label="Time, budget & interests"
        secondary
        icon="sliders"
        onPress={() => router.push("/filters")}
      />
      <Panel>
        <Icon name="shield" />
        <Copy style={{ fontWeight: "700" }}>On this device</Copy>
        <Copy>
          No account needed. Saved places and interests stay on this device.
          Location is optional and used only for a foreground search. You can
          choose an area instead. Exact coordinates aren’t saved on this device.
        </Copy>
      </Panel>
      <Copy style={[s.muted, { fontSize: 13 }]}>
        Account sync and community reports are coming later. For now, check a
        place’s website or call ahead if something looks uncertain.
      </Copy>
    </Screen>
  );
}
