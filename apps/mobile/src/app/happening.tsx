import { useState } from "react";
import { router } from "expo-router";
import { useApp } from "../state/app";
import { ActivityExperience } from "../components/ActivityExperience";
import { Button, Copy, Heading, Screen } from "../components/ui";

/** What's on: the events-only search beside the main one, one event per screen. */
export default function HappeningScreen() {
  const { happening } = useApp();
  const [index, setIndex] = useState(0);
  const back = () => (router.canGoBack() ? router.back() : router.replace("/"));
  const items = happening?.items ?? [];
  const item = items[index];
  if (!happening || !item)
    return (
      <Screen>
        <Heading>Nothing on right now</Heading>
        <Copy>
          No events fit this search. Pull to refresh on Now, or try a longer
          window.
        </Copy>
        <Button label="Back" onPress={back} />
      </Screen>
    );
  return (
    <ActivityExperience
      key={item.id}
      placeId={item.placeId}
      item={item}
      response={happening}
      position={index + 1}
      onBack={back}
      onPrevious={index > 0 ? () => setIndex((i) => i - 1) : undefined}
      onNext={
        index < items.length - 1 ? () => setIndex((i) => i + 1) : undefined
      }
    />
  );
}
