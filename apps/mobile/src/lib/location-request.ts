export class LocationProblem extends Error {
  constructor(
    readonly reason:
      | "denied"
      | "disabled"
      | "timeout"
      | "unavailable"
      | "aborted",
  ) {
    super(
      {
        denied: "You can choose an area without sharing your location.",
        disabled: "Location services are off. Choose an area to get started.",
        timeout:
          "We couldn’t find your location in time. Try again or choose an area.",
        unavailable: "We couldn’t find your location. Choose an area instead.",
        aborted: "Location request cancelled.",
      }[reason],
    );
  }
}
export type LocationPort = {
  permission: () => Promise<{ granted: boolean; canAskAgain: boolean }>;
  requestPermission: () => Promise<{ granted: boolean; canAskAgain: boolean }>;
  servicesEnabled: () => Promise<boolean>;
  position: () => Promise<{ coords: { latitude: number; longitude: number } }>;
};

/** One foreground fix. Late permissions/fixes cannot replace a manual choice or an unmounted screen. */
export function requestOrigin(
  port: LocationPort,
  askPermission: boolean,
  signal: AbortSignal,
  timeoutMs = 12_000,
): Promise<{ lat: number; lon: number }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      error?: LocationProblem,
      point?: { lat: number; lon: number },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(point!);
    };
    const abort = () => finish(new LocationProblem("aborted"));
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => finish(new LocationProblem("timeout")),
      timeoutMs,
    );
    signal.addEventListener("abort", abort);
    if (signal.aborted) {
      abort();
      return;
    }
    void (async () => {
      let permission = await port.permission();
      if (settled) return;
      if (!permission.granted && askPermission && permission.canAskAgain) {
        // Give the person time to read the system prompt. The fix still has a deadline.
        clearTimeout(timer);
        timer = undefined;
        permission = await port.requestPermission();
        if (!settled)
          timer = setTimeout(
            () => finish(new LocationProblem("timeout")),
            timeoutMs,
          );
      }
      if (settled) return;
      if (!permission.granted) throw new LocationProblem("denied");
      if (!(await port.servicesEnabled()))
        throw new LocationProblem("disabled");
      if (settled) return;
      const { coords } = await port.position();
      if (settled) return;
      const { latitude: lat, longitude: lon } = coords;
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        Math.abs(lat) > 90 ||
        Math.abs(lon) > 180
      )
        throw new LocationProblem("unavailable");
      finish(undefined, { lat, lon });
    })().catch((error: unknown) =>
      finish(
        error instanceof LocationProblem
          ? error
          : new LocationProblem("unavailable"),
      ),
    );
  });
}
