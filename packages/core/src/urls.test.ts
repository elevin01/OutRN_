import { describe, expect, it } from "vitest";
import { isMenuHostFor, isPublicWebHost } from "./urls.js";

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

  it("refuses names that only resolve inside a network: private-use, special-use and withdrawn suffixes", () => {
    for (const url of [
      "https://router.lan/menu",
      "https://router.home/menu",
      "https://nas.corp/menu",
      "https://files.private/",
      "https://portal.intranet/",
      "https://box.localdomain/",
      "https://pc.workgroup/",
      "https://setup.router/",
      "https://my.gateway/",
      "https://exchange.mail/",
      "https://www.domain/",
      "https://site.test/",
      "https://x.invalid/",
      "https://hidden.onion/",
      "https://name.alt/",
      "https://1.0.168.192.in-addr.arpa/",
    ]) expect(isPublicWebHost(hostOf(url)), url).toBe(false);
    // A numeric top label is not a TLD (the URL parser itself refuses "https://router.1/").
    expect(isPublicWebHost("router.1")).toBe(false);
    // Real public suffixes that look close stay public; .example stays allowed for fixtures.
    for (const url of ["https://menu.homes/", "https://joes.cafe/", "https://a.corporate.com/", "https://fritz.box/", "https://bageldepot.example/"]) expect(isPublicWebHost(hostOf(url)), url).toBe(true);
  });
});

describe("where a venue's menu may be", () => {
  it("on its own site, a subdomain of it, or a menu platform", () => {
    expect(isMenuHostFor("essexcoffee.com", "www.essexcoffee.com")).toBe(true);
    expect(isMenuHostFor("www.essexcoffee.com", "essexcoffee.com")).toBe(true);
    expect(isMenuHostFor("order.essexcoffee.com", "essexcoffee.com")).toBe(true);
    expect(isMenuHostFor("www.toasttab.com", null)).toBe(true);
    expect(isMenuHostFor("essex-coffee.square.site", "essexcoffee.com")).toBe(true);
  });

  it("nowhere else: another site, a lookalike, the site's parent, or with no website to compare", () => {
    expect(isMenuHostFor("evil.example", "essexcoffee.com")).toBe(false);
    expect(isMenuHostFor("essexcoffee.com.evil.example", "essexcoffee.com")).toBe(false);
    expect(isMenuHostFor("evilessexcoffee.com", "essexcoffee.com")).toBe(false);
    expect(isMenuHostFor("toasttab.com.evil.example", null)).toBe(false);
    expect(isMenuHostFor("example.com", "shop.example.com")).toBe(false);
    expect(isMenuHostFor("essexcoffee.com", null)).toBe(false);
    expect(isMenuHostFor("192.168.1.1", "192.168.1.1")).toBe(false);
    expect(isMenuHostFor("router.lan", "router.lan")).toBe(false);
  });
});

