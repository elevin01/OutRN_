import { guardedFetch, FetchBlocked, FetchFailed } from "./fetch.js";

/**
 * robots.txt (RFC 9309), for venues' own sites: we read a page only where the site's robots.txt lets
 * our agent. The group for our product token applies, else the `*` group; within it the longest
 * matching rule wins, and allow wins a tie. A robots.txt that doesn't exist (4xx) allows everything;
 * one we can't reach (5xx, a network error) allows nothing, as the RFC says, until it can be read.
 */

export interface RobotsRule {
  allow: boolean;
  /** The path pattern as written: `*` matches any run of characters, a final `$` the end of the path. */
  path: string;
}

export interface RobotsPolicy {
  /** "ok": read and parsed; "none": the site has none (4xx); "unreachable": 5xx or no answer. */
  status: "ok" | "none" | "unreachable";
  rules: RobotsRule[];
  /** Seconds to wait between requests to the site, when its group asks (capped at MAX_CRAWL_DELAY_S). */
  crawlDelayS: number | null;
}

/** The longest wait a site may ask for between our requests; a site that asks for more is read that slowly. */
export const MAX_CRAWL_DELAY_S = 120;
/** RFC 9309: a parser must handle at least 500 KiB; beyond that, what was read is what applies. */
const MAX_ROBOTS_BYTES = 512 * 1024;

/** Our product token, from the user agent ("OutRN-dev/0.1 (…)" → "outrn-dev"). */
export function productToken(userAgent: string): string {
  return (userAgent.trim().split(/[\s/]/)[0] ?? "").toLowerCase();
}

/** The rules of the group that applies to `token` (case-insensitive), else of `*`. Groups naming the same agent merge. */
export function parseRobots(text: string, token: string): { rules: RobotsRule[]; crawlDelayS: number | null } {
  const ours: RobotsRule[] = [];
  const star: RobotsRule[] = [];
  let oursDelay: number | null = null;
  let starDelay: number | null = null;
  let agents: string[] = [];
  let inRules = false;
  const want = token.toLowerCase();
  const short = want.split("-")[0] ?? want;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "user-agent") {
      if (inRules) {
        agents = [];
        inRules = false;
      }
      agents.push(value.toLowerCase());
      continue;
    }
    if (!agents.length) continue;
    inRules = true;
    const forUs = agents.some((a) => a === want || a === short);
    const forAll = agents.includes("*");
    if (!forUs && !forAll) continue;
    if (key === "allow" || key === "disallow") {
      // An empty disallow is no rule.
      if (!value) continue;
      (forUs ? ours : star).push({ allow: key === "allow", path: value });
    } else if (key === "crawl-delay") {
      const s = Number(value);
      if (Number.isFinite(s) && s >= 0) {
        if (forUs) oursDelay = s;
        else starDelay = s;
      }
    }
  }
  const usOwn = ours.length > 0 || oursDelay !== null;
  const delay = usOwn ? oursDelay : starDelay;
  return { rules: usOwn ? ours : star, crawlDelayS: delay === null ? null : Math.min(delay, MAX_CRAWL_DELAY_S) };
}

function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split("*");
  let at = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (i === 0) {
      if (!path.startsWith(part)) return false;
      at = part.length;
      continue;
    }
    const found = path.indexOf(part, at);
    if (found === -1) return false;
    at = found + part.length;
  }
  if (!anchored) return true;
  // Anchored: the last literal part must end the path (a trailing `*` before `$` matches anything).
  const last = parts[parts.length - 1]!;
  return last === "" || path.endsWith(last);
}

/** Whether `pathAndQuery` ("/menu?x=1") may be read under these rules. /robots.txt itself always may. */
export function robotsAllows(policy: RobotsPolicy, pathAndQuery: string): boolean {
  if (policy.status === "none") return true;
  if (policy.status === "unreachable") return false;
  if (pathAndQuery === "/robots.txt") return true;
  let best: RobotsRule | null = null;
  for (const r of policy.rules) {
    if (!patternMatches(r.path, pathAndQuery)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow && !best.allow)) best = r;
  }
  return best ? best.allow : true;
}

/** Read a site's robots.txt (`origin` is scheme://host[:port]). */
export async function fetchRobots(origin: string, opts: { userAgent: string; throttleKey?: string } ): Promise<RobotsPolicy> {
  try {
    const res = await guardedFetch(`${origin}/robots.txt`, {
      sourceId: "firstparty",
      ...(opts.throttleKey ? { throttleKey: opts.throttleKey } : {}),
      accept: "text/plain, */*;q=0.5",
      maxBytes: MAX_ROBOTS_BYTES,
      minIntervalMs: 1000,
      retries: 1,
      timeoutMs: 15_000,
      // RFC 9309: follow redirects (a site's robots.txt often lives at its www. or https:// address).
      allowCrossHostRedirect: true,
    });
    const parsed = parseRobots(res.text, productToken(opts.userAgent));
    return { status: "ok", ...parsed };
  } catch (e) {
    if (e instanceof FetchFailed && e.status !== undefined && e.status >= 400 && e.status < 500) return { status: "none", rules: [], crawlDelayS: null };
    // Too large to read is read as far as it goes elsewhere; here it is a site we won't guess at.
    if (e instanceof FetchBlocked) return { status: "unreachable", rules: [], crawlDelayS: null };
    return { status: "unreachable", rules: [], crawlDelayS: null };
  }
}
