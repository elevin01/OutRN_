import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { assertPublicHost, FetchBlocked, FetchFailed, guardedFetch, isPrivateAddress } from "./fetch.js";

describe("guarded fetch: destinations", () => {
  it("classifies private, loopback, link-local and mapped addresses as private", () => {
    for (const ip of [
      "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
      "::", "::1", "fd00::1", "fc00::1", "fe80::1", "ff02::1",
      "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "::ffff:10.0.0.1", "::127.0.0.1",
      "not-an-ip",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["93.184.215.14", "172.32.0.1", "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("blocks IPv6 literals, trailing-dot and .localhost names before any lookup", async () => {
    for (const url of [
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]:8080/",
      "http://[::ffff:a9fe:a9fe]/latest/meta-data/",
      "http://[fe80::1]/",
      "http://[::]/",
      "http://localhost./",
      "http://LOCALHOST/",
      "http://metadata.google.internal./",
      "http://app.localhost/",
      "http://2130706433/",
      "http://0x7f.1/",
      "file:///etc/passwd",
    ]) {
      await expect(assertPublicHost(new URL(url)), url).rejects.toBeInstanceOf(FetchBlocked);
    }
    await expect(assertPublicHost(new URL("https://93.184.215.14/"))).resolves.toBeUndefined();
  });

  describe("names that do not resolve", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("are refused without a proxy (fail closed)", async () => {
      vi.stubEnv("HTTPS_PROXY", "");
      vi.stubEnv("https_proxy", "");
      await expect(assertPublicHost(new URL("https://no-such-host.invalid/"))).rejects.toBeInstanceOf(FetchFailed);
    });

    it("are left to the proxy when one is configured", async () => {
      vi.stubEnv("HTTPS_PROXY", "http://proxy.example:3128");
      await expect(assertPublicHost(new URL("https://no-such-host.invalid/"))).resolves.toBeUndefined();
    });
  });
});

describe("guarded fetch: an internal service is never contacted", () => {
  let server: Server;
  let port = 0;
  let hits = 0;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"secret":"internal"}');
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((ok) => server.close(ok));
  });

  it("refuses loopback however it is spelled", async () => {
    for (const host of ["127.0.0.1", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "localhost."]) {
      await expect(guardedFetch(`http://${host}:${port}/`, { sourceId: "test", retries: 0, minIntervalMs: 0, timeoutMs: 2000 }), host).rejects.toBeInstanceOf(FetchBlocked);
    }
    expect(hits).toBe(0);
  });
});

describe("guarded fetch: redirects", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const redirectTo = (location: string) => new Response(null, { status: 301, headers: { location } });
  const opts = { sourceId: "redirect-test", minIntervalMs: 0, retries: 0 };

  it("never follows https down to http, even on the same host", async () => {
    const fetchStub = vi.fn(async (url: URL) => (url.protocol === "https:" ? redirectTo("http://93.184.215.14/next") : new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
    vi.stubGlobal("fetch", fetchStub);
    await expect(guardedFetch("https://93.184.215.14/start", opts)).rejects.toBeInstanceOf(FetchBlocked);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("gives up on a redirect loop", async () => {
    let n = 0;
    const fetchStub = vi.fn(async () => redirectTo(`https://93.184.215.14/hop/${++n}`));
    vi.stubGlobal("fetch", fetchStub);
    await expect(guardedFetch("https://93.184.215.14/start", opts)).rejects.toThrow(/more than 5 redirects/);
    expect(fetchStub).toHaveBeenCalledTimes(6);
  });

  it("still follows a same-host https redirect", async () => {
    const fetchStub = vi.fn(async (url: URL) => (url.pathname === "/start" ? redirectTo("/next") : new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
    vi.stubGlobal("fetch", fetchStub);
    const r = await guardedFetch("https://93.184.215.14/start", opts);
    expect([r.status, r.url]).toEqual([200, "https://93.184.215.14/next"]);
  });
});

describe("guarded fetch: pacing and size", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const ok = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

  it("spaces concurrent calls to one source by its interval", async () => {
    const at: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => (at.push(Date.now()), ok())));
    await Promise.all([1, 2, 3].map(() => guardedFetch("https://93.184.215.14/x", { sourceId: "pacing-test", minIntervalMs: 100, retries: 0 })));
    expect(at).toHaveLength(3);
    const gaps = at.slice(1).map((t, i) => t - at[i]!);
    // setTimeout may fire a millisecond early.
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(95);
  });

  it("returns the body as bytes, and as text for the callers that read text", async () => {
    const bytes = Buffer.from([0x50, 0x41, 0x52, 0x31, 0xff, 0x00]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, { status: 206, headers: { "content-type": "binary/octet-stream" } })));
    const r = await guardedFetch("https://93.184.215.14/part.parquet", { sourceId: "bytes-test", minIntervalMs: 0, retries: 0, maxBytes: 6, headers: { range: "bytes=0-5" } });
    expect([r.status, r.bytes, r.body.equals(bytes), r.text.startsWith("PAR1")]).toEqual([206, 6, true, true]);
  });

  it("refuses an oversized 206 by its content-length, without retrying", async () => {
    const fetchStub = vi.fn(async () => new Response(Buffer.alloc(1000), { status: 206, headers: { "content-length": "1000" } }));
    vi.stubGlobal("fetch", fetchStub);
    await expect(guardedFetch("https://93.184.215.14/part.parquet", { sourceId: "size-test", minIntervalMs: 0, maxBytes: 100 })).rejects.toBeInstanceOf(FetchBlocked);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("refuses an oversized 206 without a content-length as it arrives: never read in full, never retried", async () => {
    let sent = 0;
    const endless = () =>
      new ReadableStream<Uint8Array>({
        pull(ctrl) {
          // 64 MB in all unless the reader stops: far more than the 100 bytes asked for.
          if (sent >= 64 * 1024 * 1024) return ctrl.close();
          sent += 64 * 1024;
          ctrl.enqueue(new Uint8Array(64 * 1024));
        },
      });
    const fetchStub = vi.fn(async () => new Response(endless(), { status: 206 }));
    vi.stubGlobal("fetch", fetchStub);
    await expect(guardedFetch("https://93.184.215.14/part.parquet", { sourceId: "size-test", minIntervalMs: 0, maxBytes: 100 })).rejects.toBeInstanceOf(FetchBlocked);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(sent).toBeLessThanOrEqual(4 * 64 * 1024);
  });
});
