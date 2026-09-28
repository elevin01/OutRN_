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
 * Menu and ordering platforms a venue's menu may live on besides its own site. Each hosts pages for
 * the businesses that sign up, so a link there points at the venue's own listing.
 */
export const MENU_PLATFORMS: readonly string[] = [
  "toasttab.com", "squareup.com", "square.site", "clover.com", "popmenu.com", "getbento.com", "singleplatform.com",
  "menufy.com", "chownow.com", "slicelife.com", "beyondmenu.com", "grubhub.com", "seamless.com", "doordash.com",
  "ubereats.com", "opentable.com", "resy.com", "exploretock.com", "menupages.com", "allmenus.com",
];

const bare = (host: string) => host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
/** `host` is `domain` or one of its subdomains. */
const within = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/**
 * Whether a menu link may be shown for a venue. Anyone can edit an OSM `website:menu`, so it must be
 * on the venue's own site (the website's host or a subdomain of it, "www." aside) or on a known menu
 * or ordering platform. A menu anywhere else, such as a vandal's lookalike page, is dropped. Takes
 * `URL.hostname` values; `websiteHost` is null when the venue lists no website.
 */
export function isMenuHostFor(menuHost: string, websiteHost: string | null): boolean {
  if (!isPublicWebHost(menuHost)) return false;
  const menu = bare(menuHost);
  if (MENU_PLATFORMS.some((d) => within(menu, d))) return true;
  if (!websiteHost || !isPublicWebHost(websiteHost)) return false;
  return within(menu, bare(websiteHost));
}

