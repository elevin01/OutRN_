import { router } from "expo-router";
import { Button, Copy, Heading, Screen } from "../components/ui";
export default function NotFound() {
  return (
    <Screen>
      <Heading>A different{"\n"}way out.</Heading>
      <Copy>That page isn’t here. Let’s find your next plan.</Copy>
      <Button label="Back to Now" onPress={() => router.replace("/")} />
    </Screen>
  );
}
