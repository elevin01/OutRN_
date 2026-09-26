import { isIP } from "node:net";
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

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v6 = ip.toLowerCase();
  return v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80") || v6.startsWith("::ffff:127.");
}

async function assertPublicHost(url: URL): Promise<void> {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new FetchBlocked(`blocked scheme ${url.protocol}`);
  const host = url.hostname;
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new FetchBlocked(`blocked host ${host}`);
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new FetchBlocked(`blocked private address ${host}`);
    return;
  }
  // Skip DNS resolution when routed through a proxy (the proxy resolves); otherwise refuse private answers.
  if (process.env["HTTPS_PROXY"] || process.env["https_proxy"]) return;
  try {
    const answers = await lookup(host, { all: true });
    for (const a of answers) if (isPrivateAddress(a.address)) throw new FetchBlocked(`host ${host} resolves to private address`);
  } catch (e) {
    if (e instanceof FetchBlocked) throw e;
    // DNS failure surfaces as a normal fetch failure below.
  }
}

async function throttle(sourceId: string, minIntervalMs: number): Promise<void> {
  const last = lastCallAt.get(sourceId) ?? 0;
  const wait = last + minIntervalMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt.set(sourceId, Date.now());
}

export async function guardedFetch(rawUrl: string, opts: GuardedFetchOptions): Promise<GuardedResponse> {
  const url = new URL(rawUrl);
  await assertPublicHost(url);
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
        await assertPublicHost(next);
        return guardedFetch(next.toString(), { ...opts, retries: 0 });
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
      const len = Number(res.headers.get("content-length"));
      if (Number.isFinite(len) && len > maxBytes) throw new FetchBlocked(`response too large (${len} bytes) from ${url.host}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > maxBytes) throw new FetchBlocked(`response too large (${buf.byteLength} bytes) from ${url.host}`);
      const text = buf.toString("utf8");
      if (res.status >= 400) throw new FetchFailed(`${res.status} from ${url.host}: ${text.slice(0, 200)}`, res.status);
      return { status: res.status, url: url.toString(), contentType, text, bytes: buf.byteLength, fetchedAt: new Date(), attempts: attempt };
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
