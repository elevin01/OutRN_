import { readFile, writeFile } from "node:fs/promises";
import { guardedFetch } from "./fetch.js";

/**
 * Wikimedia connector, for free venue photos: Wikidata's image claim (P18) for an item, and Commons
 * file metadata (a resized copy, its author and license). Only metadata is fetched; the photo itself
 * is shown from upload.wikimedia.org with its credit.
 *
 * Requests are built deterministically (sorted, batched) so a live run can be recorded and replayed
 * exactly: tests, fixtures and offline development use the same code path as production.
 */

export const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
export const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
/** The most titles or ids either API takes in one request. */
export const WIKIMEDIA_BATCH = 50;
/** Width of the copy shown in the app. */
export const PHOTO_WIDTH = 800;

export interface JsonFetcher {
  get(url: string): Promise<unknown>;
}

/** Live fetches, paced for Wikimedia and identified by OUTRN_USER_AGENT. Records each response when asked. */
export function liveWikimediaFetcher(record?: Map<string, unknown>): JsonFetcher {
  return {
    async get(url) {
      const res = await guardedFetch(url, { sourceId: "wikimedia", accept: "application/json", allowedContentTypes: ["application/json"], minIntervalMs: 1000, timeoutMs: 30_000, retries: 2, maxBytes: 5 * 1024 * 1024 });
      const json = JSON.parse(res.text) as unknown;
      record?.set(url, json);
      return json;
    },
  };
}

/** What `--save` writes: every request's response, keyed by its exact URL. */
export interface WikimediaCapture {
  outrn_capture: "wikimedia";
  note?: string;
  responses: Record<string, unknown>;
}

/** Answers only from a capture: a request it doesn't hold is an error, never a silent gap. */
export function replayWikimediaFetcher(capture: WikimediaCapture): JsonFetcher {
  return {
    async get(url) {
      if (!(url in capture.responses)) throw new Error(`the capture has no response for ${url}: record it again with --save`);
      return capture.responses[url];
    },
  };
}

export async function loadWikimediaCapture(path: string): Promise<WikimediaCapture> {
  const data = JSON.parse(await readFile(path, "utf8")) as Partial<WikimediaCapture>;
  if (data.outrn_capture !== "wikimedia" || !data.responses || typeof data.responses !== "object") throw new Error(`${path} is not a Wikimedia capture`);
  return data as WikimediaCapture;
}

export async function saveWikimediaCapture(path: string, record: Map<string, unknown>): Promise<void> {
  const capture: WikimediaCapture = { outrn_capture: "wikimedia", responses: Object.fromEntries([...record].sort(([a], [b]) => a.localeCompare(b))) };
  await writeFile(path, JSON.stringify(capture, null, 1) + "\n", "utf8");
}

function batches<T>(items: readonly T[]): T[][] {
  const sorted = [...new Set(items)].sort();
  const out: T[][] = [];
  for (let i = 0; i < sorted.length; i += WIKIMEDIA_BATCH) out.push(sorted.slice(i, i + WIKIMEDIA_BATCH) as T[]);
  return out;
}

export function wikidataClaimsUrl(ids: readonly string[]): string {
  const p = new URLSearchParams({ action: "wbgetentities", ids: ids.join("|"), props: "claims", format: "json", formatversion: "2" });
  return `${WIKIDATA_API}?${p.toString()}`;
}

export function commonsImageInfoUrl(titles: readonly string[]): string {
  const p = new URLSearchParams({
    action: "query",
    titles: titles.join("|"),
    prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata",
    iiurlwidth: String(PHOTO_WIDTH),
    iiextmetadatafilter: "Artist|LicenseShortName|LicenseUrl|AttributionRequired|NonFree|ImageDescription|ObjectName",
    format: "json",
    formatversion: "2",
  });
  return `${COMMONS_API}?${p.toString()}`;
}

/** A Wikidata item's image claims (P18), as Commons file titles ("File:…"), in claim order. Preferred rank first. */
export async function wikidataImages(fetcher: JsonFetcher, ids: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const batch of batches(ids.filter((id) => /^Q[1-9]\d{0,11}$/.test(id)))) {
    const resp = (await fetcher.get(wikidataClaimsUrl(batch))) as { entities?: Record<string, { claims?: { P18?: { rank?: string; mainsnak?: { datavalue?: { value?: unknown } } }[] } }> };
    for (const [id, entity] of Object.entries(resp.entities ?? {})) {
      const claims = (entity.claims?.P18 ?? []).filter((c) => c.rank !== "deprecated");
      claims.sort((a, b) => Number(b.rank === "preferred") - Number(a.rank === "preferred"));
      const files = claims.map((c) => c.mainsnak?.datavalue?.value).filter((v): v is string => typeof v === "string" && v.length > 0);
      if (files.length) out.set(id, files.map((f) => `File:${f}`));
    }
  }
  return out;
}

export interface CommonsFile {
  /** The file's title as Commons normalizes it: "File:Tenement Museum.jpg". */
  title: string;
  mime: string;
  thumbUrl: string;
  thumbWidth: number;
  thumbHeight: number;
  /** The file's page on Commons: where the credit links. */
  descriptionUrl: string;
  /** extmetadata, as Commons gives it: HTML in Artist and ImageDescription. */
  meta: Record<string, string>;
}

/**
 * Commons metadata for file titles, keyed by the title as requested (Commons normalizes titles, and
 * this maps them back). Missing files are absent.
 */
export async function commonsFiles(fetcher: JsonFetcher, titles: readonly string[]): Promise<Map<string, CommonsFile>> {
  const out = new Map<string, CommonsFile>();
  for (const batch of batches(titles.filter((t) => /^File:./.test(t) && t.length <= 255))) {
    const resp = (await fetcher.get(commonsImageInfoUrl(batch))) as {
      query?: {
        normalized?: { from: string; to: string }[];
        pages?: { title?: string; missing?: boolean; invalid?: boolean; imageinfo?: { mime?: string; thumburl?: string; thumbwidth?: number; thumbheight?: number; descriptionurl?: string; extmetadata?: Record<string, { value?: unknown }> }[] }[];
      };
    };
    const byTitle = new Map<string, CommonsFile>();
    for (const page of resp.query?.pages ?? []) {
      const info = page.imageinfo?.[0];
      if (!page.title || page.missing || page.invalid || !info?.thumburl || !info.descriptionurl) continue;
      const meta: Record<string, string> = {};
      for (const [k, v] of Object.entries(info.extmetadata ?? {})) if (typeof v?.value === "string") meta[k] = v.value;
      byTitle.set(page.title, { title: page.title, mime: info.mime ?? "", thumbUrl: info.thumburl, thumbWidth: info.thumbwidth ?? 0, thumbHeight: info.thumbheight ?? 0, descriptionUrl: info.descriptionurl, meta });
    }
    const normalized = new Map((resp.query?.normalized ?? []).map((n) => [n.from, n.to]));
    for (const t of batch) {
      const f = byTitle.get(normalized.get(t) ?? t);
      if (f) out.set(t, f);
    }
  }
  return out;
}

/**
 * The Commons file a link or tag names, as a title: "File:X.jpg" (the wikimedia_commons tag), a
 * commons.wikimedia.org/wiki/File:X page, or an upload.wikimedia.org original or thumbnail. Null for
 * anything else: a photo elsewhere comes with no license we can check.
 */
export function commonsTitleFrom(ref: string): string | null {
  const s = ref.trim();
  const clean = (name: string) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(name);
    } catch {
      return null;
    }
    const t = decoded.replace(/_/g, " ").trim();
    return t && !/[|#<>[\]{}\n]/.test(t) ? `File:${t}` : null;
  };
  const tag = /^(?:File|Image):(.+)$/i.exec(s);
  if (tag) return clean(tag[1]!);
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hostname === "commons.wikimedia.org") {
    const page = /^\/wiki\/(?:File|Image):(.+)$/i.exec(url.pathname);
    return page ? clean(page[1]!) : null;
  }
  if (url.hostname === "upload.wikimedia.org") {
    // /wikipedia/commons/a/ab/Name.jpg or /wikipedia/commons/thumb/a/ab/Name.jpg/800px-Name.jpg
    const m = /^\/wikipedia\/commons\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/]+)/.exec(url.pathname);
    return m ? clean(m[1]!) : null;
  }
  return null;
}
