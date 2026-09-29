import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";

/**
 * One guarded HTTP client for every connector. Enforces:
 *  - identifying User-Agent (Overpass and NWS both require it)
 *  - per-source minimum interval between requests (from source_policies.rate_limit)
 *  - timeout, bounded retries with backoff on 429/5xx/network errors
 *  - response size cap and content-type allowlist
 *  - no private-network or link-local destinations (fetched content is untrusted input)
 *  - no redirects off the original host unless explicitly allowed
 */

export interface GuardedFetchOptions {
  sourceId: string;
  minIntervalMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
  retries?: number;
  accept?: string;
  /** Content-type prefixes accepted, e.g. ["application/json"]. */
  allowedContentTypes?: string[];
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  allowCrossHostRedirect?: boolean;
}

export interface GuardedResponse {
  status: number;
  url: string;
  contentType: string;
  text: string;
  /** The body as received, for binary replies (a parquet range); text is the same bytes as UTF-8. */
  body: Buffer;
  bytes: number;
  fetchedAt: Date;
  attempts: number;
}

export class FetchBlocked extends Error {}
export class FetchFailed extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
  }
}

const lastCallAt = new Map<string, number>();

function userAgent(): string {
  return process.env["OUTRN_USER_AGENT"] ?? "outrn-dev (set OUTRN_USER_AGENT)";
}

/**
 * Addresses a connector must never reach: this host, private networks, link-local (cloud metadata
 * at 169.254.169.254), CGNAT, benchmarking, multicast and reserved space. BlockList also matches
 * IPv4-mapped IPv6 (::ffff:169.254.169.254, ::ffff:a9fe:a9fe) against the IPv4 ranges.
 */
const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) BLOCKED.addSubnet(net, prefix, "ipv4");
// ::/96 covers ::, ::1 and IPv4-compatible addresses; then unique-local, link-local, site-local, multicast.
for (const [net, prefix] of [["::", 96], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]] as const) BLOCKED.addSubnet(net, prefix, "ipv6");

/** True for any address a connector must not reach, and for anything that is not an address. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return true;
  try {
    return BLOCKED.check(ip, family === 4 ? "ipv4" : "ipv6");
  } catch {
    return true;
  }
}

/** The host as a resolver sees it: lower case, no trailing dot, IPv6 literals without brackets. */
function hostOf(url: URL): string {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

const viaProxy = () => Boolean(process.env["HTTPS_PROXY"] || process.env["https_proxy"]);

/**
 * Refuse a destination that is, or resolves to, a non-public address. Fails closed: a name that
 * cannot be resolved is not fetched, except behind a proxy, which resolves names itself and is then
 * the egress control. Residual gap: fetch() resolves the name again, so a rebinding DNS server can
 * still answer differently between this check and the connection.
 */
export async function assertPublicHost(url: URL): Promise<void> {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new FetchBlocked(`blocked scheme ${url.protocol}`);
  const host = hostOf(url);
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw new FetchBlocked(`blocked host ${host}`);
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new FetchBlocked(`blocked private address ${host}`);
    return;
  }
  let answers: { address: string }[];
  try {
    answers = await lookup(host, { all: true, verbatim: true });
  } catch (e) {
    if (viaProxy()) return;
    throw new FetchFailed(`could not resolve ${host}: ${(e as Error).message}`);
  }
  for (const a of answers) if (isPrivateAddress(a.address)) throw new FetchBlocked(`host ${host} resolves to private address ${a.address}`);
}

/**
 * Space a source's requests by its interval. The slot is reserved before waiting, so callers that
 * arrive together (several files read at once) queue one interval apart instead of all waking at once.
 */
async function throttle(sourceId: string, minIntervalMs: number): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, (lastCallAt.get(sourceId) ?? 0) + minIntervalMs);
  lastCallAt.set(sourceId, at);
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

/**
 * The body, read only until it passes `limit` bytes: an oversized reply (whatever its content-length
 * said, or without one) is cut off there instead of read in full. `over` says it was.
 */
async function readUpTo(res: Response, limit: number): Promise<{ buf: Buffer; over: boolean }> {
  if (!res.body) return { buf: Buffer.alloc(0), over: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > limit) {
      await reader.cancel().catch(() => undefined);
      return { buf: Buffer.alloc(0), over: true };
    }
    chunks.push(value);
  }
  return { buf: Buffer.concat(chunks, n), over: false };
}

/** Redirects one fetch follows: a loop between two paths would otherwise never end. */
export const MAX_REDIRECTS = 5;

export async function guardedFetch(rawUrl: string, opts: GuardedFetchOptions, redirects = 0): Promise<GuardedResponse> {
  const url = new URL(rawUrl);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxBytes = opts.maxBytes ?? 25 * 1024 * 1024;
  const retries = opts.retries ?? 3;
  let attempt = 0;
  let lastErr: unknown;
  while (attempt <= retries) {
    attempt++;
    await throttle(opts.sourceId, opts.minIntervalMs ?? 1000);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      // Checked on every attempt, inside the try: a resolver failure is retried like a network error.
      await assertPublicHost(url);
      const res = await fetch(url, {
        method: opts.method ?? "GET",
        headers: {
          "user-agent": userAgent(),
          accept: opts.accept ?? "application/json, text/html;q=0.8, */*;q=0.5",
          ...(opts.body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
          ...(opts.headers ?? {}),
        },
        ...(opts.body !== undefined ? { body: opts.body } : {}),
        redirect: "manual",
        signal: ctrl.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) throw new FetchFailed(`redirect without location from ${url.host}`, res.status);
        const next = new URL(loc, url);
        if (next.host !== url.host && !opts.allowCrossHostRedirect) throw new FetchBlocked(`cross-host redirect ${url.host} -> ${next.host}`);
        // Never from https down to http: the rest of the exchange would travel in the clear.
        if (url.protocol === "https:" && next.protocol !== "https:") throw new FetchBlocked(`redirect from https to ${next.protocol} at ${url.host}`);
        if (redirects >= MAX_REDIRECTS) throw new FetchBlocked(`more than ${MAX_REDIRECTS} redirects from ${url.host}`);
        await assertPublicHost(next);
        return guardedFetch(next.toString(), { ...opts, retries: 0 }, redirects + 1);
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new FetchFailed(`${res.status} from ${url.host}`, res.status);
        const retryAfter = Number(res.headers.get("retry-after"));
        await new Promise((r) => setTimeout(r, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1500 * 2 ** (attempt - 1)));
        continue;
      }
      const contentType = res.headers.get("content-type") ?? "";
      if (opts.allowedContentTypes && !opts.allowedContentTypes.some((p) => contentType.startsWith(p))) {
        throw new FetchBlocked(`unexpected content-type '${contentType}' from ${url.host}`);
      }
      // Too large is refused, never retried: by the length announced, else by what arrives.
      const status = res.status >= 400 ? `, status ${res.status}` : "";
      const len = Number(res.headers.get("content-length"));
      if (res.headers.has("content-length") && Number.isFinite(len) && len > maxBytes) {
        await res.body?.cancel().catch(() => undefined);
        throw new FetchBlocked(`response too large (${len} bytes${status}) from ${url.host}`);
      }
      const { buf, over } = await readUpTo(res, maxBytes);
      if (over) throw new FetchBlocked(`response too large (over ${maxBytes} bytes${status}) from ${url.host}`);
      if (res.status >= 400) throw new FetchFailed(`${res.status} from ${url.host}: ${buf.subarray(0, 800).toString("utf8").slice(0, 200)}`, res.status);
      // Decoded on first use: a binary reply (a parquet range) is never read as text.
      let text: string | undefined;
      return { status: res.status, url: url.toString(), contentType, get text() { return (text ??= buf.toString("utf8")); }, body: buf, bytes: buf.byteLength, fetchedAt: new Date(), attempts: attempt };
    } catch (e) {
      if (e instanceof FetchBlocked) throw e;
      if (e instanceof FetchFailed && e.status && e.status < 500 && e.status !== 429) throw e;
      lastErr = e;
      if (attempt > retries) break;
      await new Promise((r) => setTimeout(r, 1500 * 2 ** (attempt - 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new FetchFailed(String(lastErr));
}
