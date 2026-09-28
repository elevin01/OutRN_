import { useEffect, useState } from "react";
import { nowIcon } from "../../lib/presentation";
import { Tabs } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, colors } from "../../components/ui";
export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const [hour, setHour] = useState(() => new Date().getHours());
  useEffect(() => {
    const timer = setInterval(() => setHour(new Date().getHours()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: {
          backgroundColor: colors.paper,
          borderTopColor: colors.border,
          height: 64 + insets.bottom,
          paddingTop: 6,
          paddingBottom: 8 + insets.bottom,
        },
        tabBarLabelStyle: {
          fontFamily: "DMSans",
          fontSize: 11,
          lineHeight: 16,
          minHeight: 16,
          flexShrink: 0,
          fontWeight: "500",
        },
        tabBarItemStyle: { paddingTop: 0, paddingBottom: 0 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Now",
          tabBarIcon: ({ color }) => (
            <Icon name={nowIcon(hour)} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="saved"
        options={{
          title: "Saved",
          tabBarIcon: ({ color }) => <Icon name="bookmark" color={color} />,
        }}
      />
      <Tabs.Screen
        name="you"
        options={{
          title: "You",
          tabBarIcon: ({ color }) => <Icon name="user" color={color} />,
        }}
      />
    </Tabs>
  );
}
