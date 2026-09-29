import { describe, expect, it } from "vitest";
import { isMenuUrlFor, isPublicWebHost } from "./urls.js";

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
  const site = "https://essexcoffee.com";

  it("on its own site, a subdomain of it, or a menu platform", () => {
    expect(isMenuUrlFor("https://essexcoffee.com/menu", "https://www.essexcoffee.com/")).toBe(true);
    expect(isMenuUrlFor("https://www.essexcoffee.com/menu", "essexcoffee.com")).toBe(true);
    expect(isMenuUrlFor("https://order.essexcoffee.com/", site)).toBe(true);
    expect(isMenuUrlFor("https://www.toasttab.com/essex-coffee/v3", null)).toBe(true);
    expect(isMenuUrlFor("https://essexcoffee.com/menu", "https://essexcoffee.com/?utm_source=gmb")).toBe(true);
  });

  it("nowhere else: another site, a lookalike, the site's parent, or with no website to compare", () => {
    expect(isMenuUrlFor("https://evil.example/menu", site)).toBe(false);
    expect(isMenuUrlFor("https://essexcoffee.com.evil.example/menu", site)).toBe(false);
    expect(isMenuUrlFor("https://evilessexcoffee.com/menu", site)).toBe(false);
    expect(isMenuUrlFor("https://toasttab.com.evil.example/", null)).toBe(false);
    expect(isMenuUrlFor("https://example.com/menu", "https://shop.example.com")).toBe(false);
    expect(isMenuUrlFor("https://essexcoffee.com/menu", null)).toBe(false);
    expect(isMenuUrlFor("https://192.168.1.1/menu", "https://192.168.1.1")).toBe(false);
    expect(isMenuUrlFor("https://router.lan/menu", "https://router.lan")).toBe(false);
  });

  it("only over https, with no credentials, and only when it parses", () => {
    expect(isMenuUrlFor("http://essexcoffee.com/menu", site)).toBe(false);
    expect(isMenuUrlFor("https://user:pass@essexcoffee.com/menu", site)).toBe(false);
    expect(isMenuUrlFor("https://essexcoffee.com@evil.example/menu", site)).toBe(false);
    expect(isMenuUrlFor("javascript:alert(1)", site)).toBe(false);
    expect(isMenuUrlFor("essexcoffee.com/menu", site)).toBe(false);
  });

  it("never on a free site builder, whatever the website says", () => {
    for (const menu of ["https://essex-coffee-order.square.site/", "https://squareup.com/store/essex-coffee-order", "https://essex.menufy.com/", "https://www.beyondmenu.com/essex"]) {
      expect(isMenuUrlFor(menu, site), menu).toBe(false);
      expect(isMenuUrlFor(menu, null), menu).toBe(false);
    }
  });

  it("on a host shared by path, only under the venue's own path", () => {
    const fb = "https://www.facebook.com/essexcoffee";
    expect(isMenuUrlFor("https://www.facebook.com/essexcoffee/menu", fb)).toBe(true);
    expect(isMenuUrlFor("https://facebook.com/essexcoffee", `${fb}/`)).toBe(true);
    expect(isMenuUrlFor("https://www.facebook.com/SomeoneElsesPage", fb)).toBe(false);
    expect(isMenuUrlFor("https://www.facebook.com/essexcoffeeorder", fb)).toBe(false);
    expect(isMenuUrlFor("https://m.facebook.com/essexcoffee", fb)).toBe(false);
    expect(isMenuUrlFor("https://www.facebook.com/", fb)).toBe(false);
    expect(isMenuUrlFor("https://sites.google.com/view/someone-else/menu", "https://sites.google.com/view/essexcoffee")).toBe(false);
    expect(isMenuUrlFor("https://linktr.ee/someoneelse", "https://linktr.ee/essexcoffee")).toBe(false);
  });

  it("with no way out of that path, and none when the website names its tenant in a query", () => {
    const fb = "https://www.facebook.com/essexcoffee";
    expect(isMenuUrlFor("https://www.facebook.com/essexcoffee/../SomeoneElsesPage", fb)).toBe(false);
    expect(isMenuUrlFor("https://www.facebook.com/essexcoffee/%2e%2e/SomeoneElsesPage", fb)).toBe(false);
    expect(isMenuUrlFor("https://www.facebook.com/essexcoffee/..%2fSomeoneElsesPage", fb)).toBe(false);
    expect(isMenuUrlFor("https://www.facebook.com/essexcoffee/..%5CSomeoneElsesPage", fb)).toBe(false);
    expect(isMenuUrlFor("https://www.facebook.com/profile.php?id=999", "https://www.facebook.com/profile.php?id=123")).toBe(false);
  });
});
