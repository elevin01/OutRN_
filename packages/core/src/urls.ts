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

export function isPublicWebHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || host.startsWith("[")) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  return !LOCAL_SUFFIX.test(host);
}
