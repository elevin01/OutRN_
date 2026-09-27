import { Pressable, View } from "react-native";
import { router } from "expo-router";
import { useApp } from "../../state/app";
import {
  Button,
  Copy,
  Eyebrow,
  Heading,
  Icon,
  IconButton,
  Loading,
  Panel,
  Row,
  Screen,
  s,
} from "../../components/ui";
import { PlaceArt } from "../../components/PlaceArt";
export default function SavedScreen() {
  const { saved, toggleSaved, hydrated, storageError } = useApp();
  return (
    <Screen>
      <Eyebrow>For another good day</Eyebrow>
      <Heading>Keep a few{"\n"}good ideas.</Heading>
      <Copy style={s.muted}>
        Saved on this device. Check the latest details when you’re ready.
      </Copy>
      {storageError && (
        <Panel warm>
          <Copy accessibilityRole="alert">{storageError}</Copy>
        </Panel>
      )}
      {!hydrated ? (
        <Loading />
      ) : !saved.length ? (
        <Panel>
          <Icon name="bookmark" size={32} />
          <Heading>Something to{"\n"}look forward to.</Heading>
          <Copy>Save a place from its detail page. It’ll be waiting here.</Copy>
          <Button label="Find somewhere" onPress={() => router.navigate("/")} />
        </Panel>
      ) : (
        saved.map((place) => (
          <Row key={place.id}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`View saved place ${place.name}`}
              onPress={() =>
                router.push({
                  pathname: "/place/[id]",
                  params: { id: place.id },
                })
              }
              style={{ flex: 1 }}
            >
              <Row>
                <PlaceArt category={place.category} compact />
                <View style={{ flex: 1 }}>
                  <Copy style={{ fontWeight: "700" }}>{place.name}</Copy>
                  <Copy style={s.muted}>View current details</Copy>
                </View>
              </Row>
            </Pressable>
            <IconButton
              name="x"
              label={`Remove ${place.name} from saved`}
              onPress={() => toggleSaved(place)}
            />
          </Row>
        ))
      )}
    </Screen>
  );
}
