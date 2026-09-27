import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type TextProps,
  type ColorValue,
  type RefreshControlProps,
  type ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Feather from "@expo/vector-icons/Feather";
import { demoMode } from "../lib/api";
export const colors = {
  paper: "#F7F5EF",
  surface: "#FFFFFF",
  ink: "#20251F",
  muted: "#626A60",
  signal: "#F36B3F",
  accent: "#AD361A",
  sage: "#E5EDDF",
  green: "#3D614C",
  warm: "#FBE5D9",
  border: "#DCDDD4",
};
export type IconName = React.ComponentProps<typeof Feather>["name"];
export const Icon = ({
  name,
  size = 22,
  color = colors.ink,
}: {
  name: IconName;
  size?: number;
  color?: ColorValue;
}) => (
  <Feather
    name={name}
    size={size}
    color={color}
    accessible={false}
    aria-hidden={true}
  />
);
export function Copy({ children, style, ...props }: TextProps) {
  return (
    <Text {...props} style={[s.copy, style]}>
      {children}
    </Text>
  );
}
export function Heading({ children }: { children: ReactNode }) {
  return (
    <Copy accessibilityRole="header" style={s.heading}>
      {children}
    </Copy>
  );
}
export function Eyebrow({ children }: { children: ReactNode }) {
  return <Copy style={s.eyebrow}>{children}</Copy>;
}
export function Button({
  label,
  onPress,
  secondary,
  disabled,
  icon,
}: {
  label: string;
  onPress: () => void;
  secondary?: boolean;
  disabled?: boolean;
  icon?: IconName;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        secondary && s.secondary,
        { opacity: disabled ? 0.45 : pressed ? 0.7 : 1 },
      ]}
    >
      <Copy style={s.buttonText}>{label}</Copy>
      {icon && <Icon name={icon} size={19} />}
    </Pressable>
  );
}
export function IconButton({
  name,
  label,
  onPress,
  selected,
}: {
  name: IconName;
  label: string;
  onPress: () => void;
  selected?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        s.iconButton,
        selected && { backgroundColor: colors.sage },
        pressed && { opacity: 0.65 },
      ]}
    >
      <Icon name={name} />
    </Pressable>
  );
}
export function Chip({
  label,
  selected,
  onPress,
  disabled,
}: {
  label: string;
  selected?: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[s.chip, selected && s.chipSelected, disabled && { opacity: 0.4 }]}
    >
      <Copy
        style={{ color: selected ? "#FFF" : colors.ink, fontWeight: "600" }}
      >
        {label}
      </Copy>
    </Pressable>
  );
}
export function Screen({
  children,
  footer,
  refreshControl,
}: {
  children: ReactNode;
  footer?: ReactNode;
  refreshControl?: React.ReactElement<RefreshControlProps>;
}) {
  return (
    <SafeAreaView edges={["top", "left", "right"]} style={s.safe}>
      <ScrollView
        contentContainerStyle={s.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={refreshControl}
      >
        {demoMode && (
          <Copy style={s.demo}>
            DEMO · Invented places and fixed example times
          </Copy>
        )}
        {children}
      </ScrollView>
      {footer && (
        <SafeAreaView edges={["bottom"]} style={s.footer}>
          {footer}
        </SafeAreaView>
      )}
    </SafeAreaView>
  );
}
export function Row({
  children,
  style,
}: {
  children: ReactNode;
  style?: ViewStyle;
}) {
  return <View style={[s.row, style]}>{children}</View>;
}
export function Panel({
  children,
  warm,
}: {
  children: ReactNode;
  warm?: boolean;
}) {
  return (
    <View style={[s.panel, warm && { backgroundColor: colors.warm }]}>
      {children}
    </View>
  );
}
export function Loading({
  label = "Finding a good way to spend your time…",
}: {
  label?: string;
}) {
  return (
    <View accessibilityRole="progressbar" style={s.loading}>
      <ActivityIndicator color={colors.green} />
      <Copy style={s.muted}>{label}</Copy>
    </View>
  );
}
export function Problem({
  message,
  retry,
  label = "Try again",
}: {
  message: string;
  retry?: () => void;
  label?: string;
}) {
  return (
    <Panel warm>
      <Icon name="wifi-off" />
      <Heading>A little pause.</Heading>
      <Copy accessibilityRole="alert">{message}</Copy>
      {retry && <Button label={label} onPress={retry} secondary />}
    </Panel>
  );
}
export const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper },
  content: {
    padding: 24,
    gap: 22,
    width: "100%",
    maxWidth: 600,
    alignSelf: "center",
    paddingBottom: 36,
  },
  copy: {
    fontFamily: "DMSans",
    flexShrink: 1,
    fontSize: 16,
    lineHeight: 24,
    color: colors.ink,
  },
  heading: {
    fontSize: 34,
    lineHeight: 39,
    fontWeight: "700",
    letterSpacing: -1.2,
  },
  eyebrow: {
    fontSize: 11,
    lineHeight: 17,
    letterSpacing: 1.7,
    fontWeight: "700",
    color: colors.muted,
    textTransform: "uppercase",
  },
  muted: { color: colors.muted },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  between: { justifyContent: "space-between" },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  button: {
    backgroundColor: colors.signal,
    borderRadius: 18,
    minHeight: 54,
    paddingHorizontal: 20,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  buttonText: { fontWeight: "700" },
  secondary: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  iconButton: {
    minWidth: 48,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 24,
    backgroundColor: colors.surface,
  },
  chip: {
    minHeight: 46,
    paddingHorizontal: 17,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 24,
    backgroundColor: colors.surface,
  },
  chipSelected: { backgroundColor: colors.ink, borderColor: colors.ink },
  panel: {
    padding: 22,
    gap: 14,
    backgroundColor: colors.sage,
    borderRadius: 24,
  },
  footer: {
    padding: 16,
    gap: 10,
    borderTopWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.paper,
  },
  loading: {
    minHeight: 240,
    justifyContent: "center",
    alignItems: "center",
    gap: 18,
  },
  demo: { fontSize: 11, lineHeight: 17, color: colors.accent },
  divider: { height: 1, backgroundColor: colors.border },
});
