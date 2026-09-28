import { router, useLocalSearchParams } from "expo-router";
import { useApp } from "../../state/app";
import { ActivityExperience } from "../../components/ActivityExperience";
export default function PlaceScreen() {
  const { id, itemId } = useLocalSearchParams<{
    id: string;
    itemId?: string;
  }>();
  const { result } = useApp();
  const item = result?.items.find((i) => i.id === itemId && i.placeId === id);
  return (
    <ActivityExperience
      key={`${id}:${itemId || "details"}`}
      placeId={id}
      item={item}
      response={item ? result : undefined}
      onBack={() => (router.canGoBack() ? router.back() : router.replace("/"))}
    />
  );
}
