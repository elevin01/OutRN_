import { router } from "expo-router";
import { useApp } from "../../state/app";
import { pickOf } from "../../lib/taste";
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
  const { areas, query, outing, taste } = useApp();
  const likes = (areas?.filters.interests ?? []).filter(
    (i) => pickOf(taste, i.id) === "like",
  );
  return (
    <Screen>
      <Heading>You</Heading>
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
      <Panel>
        <Icon name="heart" />
        <Eyebrow>What you like</Eyebrow>
        <Copy>
          {likes.length
            ? likes.map((i) => i.label).join(", ")
            : "Tell us what you like doing, and it comes first."}
        </Copy>
        <Button
          label="Your interests"
          secondary
          onPress={() => router.push("/interests")}
        />
      </Panel>
      <Button
        label="Time, budget & mood"
        secondary
        icon="sliders"
        onPress={() => router.push("/filters")}
      />
      <Panel>
        <Icon name="shield" />
        <Copy style={{ fontWeight: "700" }}>On this device</Copy>
        <Copy>
          No account needed. Saved places and your interests stay on this
          device; each search sends your interests to rank what’s open, and
          OutRN doesn’t keep them. OutRN doesn’t request or track your device
          location.
        </Copy>
      </Panel>
      <Copy style={[s.muted, { fontSize: 13 }]}>
        Account sync and community reports are coming later. For now, check a
        place’s website or call ahead if something looks uncertain.
      </Copy>
    </Screen>
  );
}
