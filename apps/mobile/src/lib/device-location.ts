import * as Location from "expo-location";
import { requestOrigin } from "./location-request";

export function deviceOrigin(askPermission: boolean, signal: AbortSignal) {
  return requestOrigin(
    {
      permission: Location.getForegroundPermissionsAsync,
      requestPermission: Location.requestForegroundPermissionsAsync,
      servicesEnabled: Location.hasServicesEnabledAsync,
      position: () =>
        Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
          mayShowUserSettingsDialog: false,
        }),
    },
    askPermission,
    signal,
  );
}
