import { useEffect, useRef, type ReactNode } from "react";
import {
  AccessibilityInfo,
  findNodeHandle,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Copy, IconButton, colors } from "./ui";

export function Sheet({
  visible,
  title,
  close,
  children,
}: {
  visible: boolean;
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const heading = useRef<View>(null);
  useEffect(() => {
    if (!visible || Platform.OS === "web") return;
    const timer = setTimeout(() => {
      const node = findNodeHandle(heading.current);
      if (node) AccessibilityInfo.setAccessibilityFocus(node);
    }, 350);
    return () => clearTimeout(timer);
  }, [visible]);
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={close}
      statusBarTranslucent
    >
      <View style={styles.overlay}>
        <Pressable
          style={StyleSheet.absoluteFill}
          accessibilityLabel="Close sheet"
          accessibilityRole="button"
          onPress={close}
        />
        <View
          accessibilityViewIsModal
          style={[
            styles.sheet,
            { paddingBottom: Math.max(insets.bottom, 16), maxHeight: "90%" },
          ]}
        >
          <View ref={heading} style={styles.header}>
            <Copy accessibilityRole="header" style={styles.title}>
              {title}
            </Copy>
            <IconButton name="x" label={`Close ${title}`} onPress={close} />
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.body}
          >
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "#08140f88",
  },
  sheet: {
    width: "100%",
    maxWidth: 600,
    alignSelf: "center",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    backgroundColor: colors.paper,
    padding: 24,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    marginBottom: 12,
  },
  title: { fontSize: 20, lineHeight: 26, fontWeight: "600" },
  body: { gap: 16, paddingBottom: 12 },
});
