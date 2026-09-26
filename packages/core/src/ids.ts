import { createHash, randomUUID } from "node:crypto";

export function uuid(): string {
  return randomUUID();
}

/** Stable content hash for idempotent imports. */
export function contentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

/** Normalize a name for matching: lowercase, strip punctuation/diacritics, collapse whitespace, drop legal suffixes. */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|inc|llc|ltd|co|restaurant|cafe|bar|nyc|new york)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Registrable domain-ish key from a URL: strips scheme, www, path. Not a full PSL implementation. */
export function domainKey(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.includes("://") ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/** Digits-only phone key with US country code stripped. */
export function phoneKey(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return null;
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}
