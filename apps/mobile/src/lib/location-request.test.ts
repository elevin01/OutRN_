import { afterEach, describe, expect, it, vi } from "vitest";
import { requestOrigin, type LocationPort } from "./location-request";

function port(): LocationPort {
  return {
    permission: vi.fn().mockResolvedValue({ granted: true, canAskAgain: true }),
    requestPermission: vi
      .fn()
      .mockResolvedValue({ granted: true, canAskAgain: true }),
    servicesEnabled: vi.fn().mockResolvedValue(true),
    position: vi
      .fn()
      .mockResolvedValue({ coords: { latitude: 40.72, longitude: -73.99 } }),
  };
}
afterEach(() => vi.useRealTimers());
describe("foreground location entry", () => {
  it("gets one fix with existing permission without prompting", async () => {
    const client = port();
    expect(
      await requestOrigin(client, false, new AbortController().signal),
    ).toEqual({ lat: 40.72, lon: -73.99 });
    expect(client.requestPermission).not.toHaveBeenCalled();
    expect(client.position).toHaveBeenCalledOnce();
  });
  it("only requests permission after an explicit action", async () => {
    const client = port();
    client.permission = vi
      .fn()
      .mockResolvedValue({ granted: false, canAskAgain: true });
    await expect(
      requestOrigin(client, false, new AbortController().signal),
    ).rejects.toMatchObject({ reason: "denied" });
    expect(client.requestPermission).not.toHaveBeenCalled();
    await requestOrigin(client, true, new AbortController().signal);
    expect(client.requestPermission).toHaveBeenCalledOnce();
  });
  it("routes permanent denial and disabled services to manual entry", async () => {
    const client = port();
    client.permission = vi
      .fn()
      .mockResolvedValue({ granted: false, canAskAgain: false });
    await expect(
      requestOrigin(client, true, new AbortController().signal),
    ).rejects.toMatchObject({ reason: "denied" });
    expect(client.requestPermission).not.toHaveBeenCalled();
    expect(client.position).not.toHaveBeenCalled();
    const disabled = port();
    disabled.servicesEnabled = vi.fn().mockResolvedValue(false);
    await expect(
      requestOrigin(disabled, true, new AbortController().signal),
    ).rejects.toMatchObject({ reason: "disabled" });
    expect(disabled.position).not.toHaveBeenCalled();
  });
  it("cancels before a late permission response can access location", async () => {
    const client = port();
    let release!: (value: { granted: boolean; canAskAgain: boolean }) => void;
    client.permission = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const controller = new AbortController();
    const pending = requestOrigin(client, true, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ reason: "aborted" });
    release({ granted: true, canAskAgain: true });
    await Promise.resolve();
    expect(client.position).not.toHaveBeenCalled();
  });
  it("times out a hung fix and ignores its late result", async () => {
    vi.useFakeTimers();
    const client = port();
    let release!: (value: {
      coords: { latitude: number; longitude: number };
    }) => void;
    client.position = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const pending = requestOrigin(
      client,
      true,
      new AbortController().signal,
      100,
    );
    const assertion = expect(pending).rejects.toMatchObject({
      reason: "timeout",
    });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    release({ coords: { latitude: 1, longitude: 2 } });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("allows time to answer the permission prompt, then bounds the fix", async () => {
    vi.useFakeTimers();
    const client = port();
    client.permission = vi
      .fn()
      .mockResolvedValue({ granted: false, canAskAgain: true });
    let grant!: (value: { granted: boolean; canAskAgain: boolean }) => void;
    client.requestPermission = () =>
      new Promise((resolve) => {
        grant = resolve;
      });
    const pending = requestOrigin(
      client,
      true,
      new AbortController().signal,
      100,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.position).not.toHaveBeenCalled();
    grant({ granted: true, canAskAgain: true });
    await expect(pending).resolves.toEqual({ lat: 40.72, lon: -73.99 });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects malformed device coordinates", async () => {
    const client = port();
    client.position = vi
      .fn()
      .mockResolvedValue({ coords: { latitude: NaN, longitude: 500 } });
    await expect(
      requestOrigin(client, true, new AbortController().signal),
    ).rejects.toMatchObject({ reason: "unavailable" });
  });
});
