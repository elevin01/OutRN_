/**
 * Whether a link we put in front of a user may point at this host: a public DNS name. Such links
 * come from sources anyone can edit (OSM website, website:menu), and no real venue page lives at an
 * IP literal, on localhost, or behind a single-label or network-local name. Those would point a tap
 * at the user's own router, other devices on their network, or a cloud metadata address.
 *
 * Takes `URL.hostname`, which the URL parser has already normalized: every IPv4 spelling (hex,
 * octal, a bare integer) becomes a dotted quad, and IPv6 stays bracketed.
 */
const LOCAL_SUFFIX = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/;

/**
 * Top-level names that only ever resolve inside someone's network, never on the public internet:
 * IETF special-use names (RFC 6761, 6762, 7686, 8375, 9476), ICANN's reserved .internal, the names
 * ICANN withdrew because private networks already use them (.home, .corp, .mail), and the suffixes
 * routers and intranets commonly use. `.example` is deliberately absent: fixtures use it.
 */
const PRIVATE_TLDS = new Set([
  "localhost", "local", "test", "invalid", "onion", "alt", "arpa", "internal",
  "home", "corp", "mail",
  "lan", "private", "intranet", "localdomain", "domain", "workgroup", "router", "gateway", "localnet", "priv",
]);

/** A top-level label that could be delegated: letters only, or an IDN in punycode. */
const TLD_SHAPE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

export function isPublicWebHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || host.startsWith("[")) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  if (LOCAL_SUFFIX.test(host)) return false;
  const tld = host.slice(host.lastIndexOf(".") + 1);
  return TLD_SHAPE.test(tld) && !PRIVATE_TLDS.has(tld);
}

/**
 * Menu and ordering platforms a venue's menu may live on besides its own site. A page exists on each
 * only for a business that signed up with it as a merchant, so a link there points at a real
 * business's listing. Free site builders (square.site, squareup.com's stores) are not on the list:
 * anyone can publish a page there, so a menu on one counts only when it is the venue's own website.
 * Platforms we can't confirm vet their merchants are left off too: a missing link is never a wrong one.
 */
export const MENU_PLATFORMS: readonly string[] = [
  "toasttab.com", "clover.com", "popmenu.com", "getbento.com", "singleplatform.com", "chownow.com", "slicelife.com",
  "grubhub.com", "seamless.com", "doordash.com", "ubereats.com", "opentable.com", "resy.com", "exploretock.com",
  "menupages.com", "allmenus.com",
];

const bare = (host: string) => host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
/** `host` is `domain` or one of its subdomains. */
const within = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** A venue's website as written in a tag or fact ("essexcoffee.com" or a full URL), as a URL; null when it names none. */
export function siteUrl(site: string | null | undefined): URL | null {
  const s = site?.trim();
  if (!s) return null;
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
}

/**
 * Whether a menu link may be shown for a venue. Anyone can edit an OSM `website:menu`, so it must be
 * an https page, with no credentials in it, on the venue's own site or on a known menu or ordering
 * platform. A menu anywhere else (a vandal's lookalike page, a free site builder) is dropped.
 *
 * The own site is the website's host ("www." aside) or a subdomain of it. A website with a path may
 * be one tenant of a shared host (facebook.com/…, sites.google.com/view/…, linktr.ee/…), so then
 * only pages on that host under that path count: another tenant's page is not the venue's site.
 * Such a menu may not spell a slash, backslash or dot in percent-encoding (a server that decodes
 * them could step out of the path), and a website that names its tenant in a query
 * (facebook.com/profile.php?id=…) gives no site to compare with.
 */
export function isMenuUrlFor(menu: string, website: string | null): boolean {
  let m: URL;
  try {
    m = new URL(menu);
  } catch {
    return false;
  }
  if (m.protocol !== "https:" || m.username || m.password || !isPublicWebHost(m.hostname)) return false;
  const host = bare(m.hostname);
  if (MENU_PLATFORMS.some((d) => within(host, d))) return true;
  const w = siteUrl(website);
  if (!w || !isPublicWebHost(w.hostname)) return false;
  const site = bare(w.hostname);
  const path = w.pathname.replace(/\/+$/, "");
  if (!path) return within(host, site);
  if (w.search || /%(2f|5c|2e)/i.test(m.pathname)) return false;
  return host === site && (m.pathname === path || m.pathname.startsWith(`${path}/`));
}
