import { router, useLocalSearchParams } from "expo-router";
import { useApp } from "../../state/app";
import { ActivityExperience } from "../../components/ActivityExperience";
export default function PlaceScreen() {
  const { id, itemId, source } = useLocalSearchParams<{
    id: string;
    itemId?: string;
    source?: string;
  }>();
  const { result, savedPlan } = useApp();
  const fromSaved =
    source === "saved" &&
    savedPlan &&
    savedPlan.item.id === itemId &&
    savedPlan.item.placeId === id
      ? savedPlan
      : undefined;
  const item =
    fromSaved?.item ??
    result?.items.find((i) => i.id === itemId && i.placeId === id);
  return (
    <ActivityExperience
      key={`${id}:${itemId || "details"}`}
      placeId={id}
      item={item}
      response={fromSaved?.response ?? (item ? result : undefined)}
      onBack={() => (router.canGoBack() ? router.back() : router.replace("/"))}
    />
  );
}
