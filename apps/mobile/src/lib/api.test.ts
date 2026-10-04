import { describe, expect, it, vi } from "vitest";
import { areas, errors, scenarios } from "@outrn/contracts/fixtures";
import { createApi, RequestError, resolveApiUrl } from "./api";
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
describe("release API address", () => {
  it("defaults to loopback only in development", () => {
    expect(resolveApiUrl(undefined, true)).toBe("http://127.0.0.1:4000");
    for (const value of [undefined, "", " "])
      expect(() => resolveApiUrl(value, false)).toThrow(/https/i);
  });
  it("accepts HTTPS and explicit loopback previews", () => {
    for (const url of [
      "https://api.example/v1base",
      "http://localhost:4000",
      "http://127.0.0.1:4000",
      "http://[::1]:4000",
    ])
      expect(resolveApiUrl(url, false)).toBe(url);
  });
  it("rejects insecure hosts, deceptive authorities, credentials, and malformed URLs", () => {
    for (const url of [
      "http://api.example",
      "http://192.168.1.20:4000",
      "http://10.0.2.2:4000",
      "http://127.0.0.1.evil.example",
      "http://localhost@evil.example",
      "http://[::1]@evil.example",
      "http://localhost:4000@evil.example",
      "https://user:secret@api.example",
      "https://api.example?key=secret",
      "ftp://api.example",
      "api.example",
      "http://",
      "https://api.example:bad",
    ])
      expect(() => resolveApiUrl(url, false), url).toThrow();
  });
  it("permits LAN development for a physical phone", () => {
    expect(resolveApiUrl("http://192.168.1.20:4000", true)).toBe(
      "http://192.168.1.20:4000",
    );
  });
});
describe("mobile HTTP boundary", () => {
  it("retains backend origin validation so device entry can recover to an area", async () => {
    const fields = [{ path: "origin", message: "outside the supported area" }];
    const transport = vi
      .fn()
      .mockResolvedValue(
        response(
          {
            error: {
              code: "VALIDATION_FAILED",
              message: "Choose an area",
              retryable: false,
              fields,
            },
          },
          400,
        ),
      );
    await expect(
      createApi("https://api.example", transport).recommend({
        areaId: "les",
        windowMinutes: 120,
        origin: { lat: 40, lon: -73 },
      }),
    ).rejects.toMatchObject({ fields });
  });
  it("validates successful responses and preserves additive fields", async () => {
    const transport = vi
      .fn()
      .mockResolvedValue(response({ ...areas, future: true }));
    const result = await createApi("https://api.example/", transport).areas();
    expect(result.defaultAreaId).toBe(areas.defaultAreaId);
    expect(transport.mock.calls[0][0]).toBe("https://api.example/v1/areas");
  });
  it("rejects malformed success payloads rather than showing fabricated empty results", async () => {
    const client = createApi(
      "https://api.example",
      vi.fn().mockResolvedValue(response({ items: [] })),
    );
    await expect(
      client.recommend({ areaId: "les", windowMinutes: 120 }),
    ).rejects.toMatchObject({ code: "CONTRACT_MISMATCH", retryable: false });
  });
  it("passes paging cursors unchanged and retains the expired-search restart", async () => {
    const fixture = errors["cursor-expired"]!;
    const transport = vi
      .fn()
      .mockResolvedValue(response(fixture.body, fixture.status));
    await expect(
      createApi("https://api.example", transport).recommend({
        cursor: "opaque+cursor/=",
      }),
    ).rejects.toMatchObject({
      code: "CURSOR_EXPIRED",
      restart: fixture.body.error.restart,
    });
    expect(JSON.parse(transport.mock.calls[0][1].body)).toEqual({
      cursor: "opaque+cursor/=",
    });
  });
  it("retains required caveats and backend order", async () => {
    const fixture = scenarios.find((s) =>
      s.pages.some((p) => p.items.some((i) => i.caveats.length)),
    )!.pages[0]!;
    const result = await createApi(
      "https://api.example",
      vi.fn().mockResolvedValue(response(fixture)),
    ).recommend({ areaId: "les", windowMinutes: 120 });
    expect(result.items).toEqual(fixture.items);
  });
  it("exposes recoverable connection errors without leaking the API URL", async () => {
    await expect(
      createApi(
        "https://private.example",
        vi.fn().mockRejectedValue(new Error("offline")),
      ).areas(),
    ).rejects.toMatchObject({ code: "UNREACHABLE", retryable: true });
  });
  it("forwards cancellation and clears its timeout", async () => {
    const controller = new AbortController();
    const transport = vi.fn(
      (_url, options) =>
        new Promise<Response>((_resolve, reject) =>
          options.signal.addEventListener("abort", () =>
            reject(new Error("aborted")),
          ),
        ),
    );
    const promise = createApi(
      "https://api.example",
      transport as typeof fetch,
    ).areas(controller.signal);
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(RequestError);
    expect(transport.mock.calls[0][1].signal.aborted).toBe(true);
  });
});
