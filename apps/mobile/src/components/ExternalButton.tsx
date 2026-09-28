import { useState } from "react";
import { Linking, View } from "react-native";
import { Button, Copy } from "./ui";
import { safeExternalUrl } from "../lib/presentation";
export function ExternalButton({
  url,
  label,
  phone,
  secondary = true,
}: {
  url: string;
  label: string;
  phone?: boolean;
  secondary?: boolean;
}) {
  const [error, setError] = useState(false);
  const safe = safeExternalUrl(url, phone);
  return (
    <View style={{ gap: 8 }}>
      <Button
        label={label}
        icon="arrow-up-right"
        secondary={secondary}
        disabled={!safe}
        onPress={() => {
          setError(false);
          void Linking.openURL(safe!).catch(() => setError(true));
        }}
      />
      {error && (
        <Copy accessibilityRole="alert">
          Couldn’t open that link. Please try again.
        </Copy>
      )}
    </View>
  );
}
