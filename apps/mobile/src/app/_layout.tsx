import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useFonts } from "expo-font";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppProvider } from "../state/app";
import { colors, Loading } from "../components/ui";
export default function RootLayout() {
  const [loaded, error] = useFonts({
    DMSans: require("../../assets/fonts/DM-Sans.ttf"),
  });
  if (!loaded && !error) return <Loading label="A good few hours ahead." />;
  return (
    <SafeAreaProvider>
      <AppProvider>
        <StatusBar style="dark" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.paper },
          }}
        >
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="filters" options={{ presentation: "modal" }} />
          <Stack.Screen name="areas" options={{ presentation: "modal" }} />
        </Stack>
      </AppProvider>
    </SafeAreaProvider>
  );
}
