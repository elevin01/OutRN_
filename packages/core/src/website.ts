import { isPublicWebHost } from "./urls.js";

/**
 * A website as written in an OSM tag or a fact, as an absolute http(s) URL a user may be sent to;
 * null when it names none. OSM often omits the scheme ("example.com"), and anyone can edit the tag:
 * no other scheme, no IP literal or local name, no free text.
 */
export function websiteUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : /^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(s) ? `https://${s}` : null;
  if (!withScheme) return null;
  try {
    const u = new URL(withScheme);
    return (u.protocol === "http:" || u.protocol === "https:") && isPublicWebHost(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}
