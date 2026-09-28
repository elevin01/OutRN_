import { describe, expect, it } from "vitest";
import { isPublicWebHost } from "./urls.js";

const hostOf = (url: string) => new URL(url).hostname;

describe("links shown to users point at public hosts only", () => {
  it("accepts public DNS names, reserved example domains included", () => {
    for (const url of ["https://bageldepot.example/", "https://www.menu-site.com/r/1", "https://xn--caf-dma.com/", "https://sub.domain.co.uk/"]) expect(isPublicWebHost(hostOf(url)), url).toBe(true);
  });

  it("refuses IP literals however they are spelled, loopback and network-local names", () => {
    for (const url of [
      "https://169.254.169.254/latest/meta-data/",
      "https://192.168.1.1/admin",
      "http://10.0.0.1/",
      "https://0x7f.1/",
      "https://2130706433/",
      "https://8.8.8.8/",
      "https://[::1]/",
      "https://[::ffff:169.254.169.254]/",
      "https://localhost/",
      "https://app.localhost/",
      "https://router.local/",
      "https://metadata.google.internal./",
      "https://printer.home.arpa/",
      "https://nas.localdomain/",
      "https://intranet/",
    ]) expect(isPublicWebHost(hostOf(url)), url).toBe(false);
  });
});
