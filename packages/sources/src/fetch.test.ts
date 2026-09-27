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
