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
/**
 * Commons' tags for a file that may be deleted: nominated for deletion, a speedy-deletion candidate,
 * a copyright violation, or missing a license, a source or permission. Asked for by template rather
 * than category, since the template is what files it and its category may be hidden.
 */
export const DELETION_TEMPLATES: readonly string[] = [
  "Template:Delete", "Template:Speedydelete", "Template:Copyvio", "Template:No license since", "Template:No source since", "Template:No permission since",
];

export interface JsonFetcher {
  get(url: string): Promise<unknown>;
}

/** Live fetches, paced for Wikimedia and identified by OUTRN_USER_AGENT. */
export function liveWikimediaFetcher(): JsonFetcher {
  return {
    async get(url) {
      const res = await guardedFetch(url, { sourceId: "wikimedia", accept: "application/json", allowedContentTypes: ["application/json"], minIntervalMs: 1000, timeoutMs: 30_000, retries: 2, maxBytes: 5 * 1024 * 1024 });
      return JSON.parse(res.text) as unknown;
    },
  };
}

/** Answers from `inner` and keeps every response by its URL, for `--save`. */
export function recordingFetcher(inner: JsonFetcher, record: Map<string, unknown>): JsonFetcher {
  return {
    async get(url) {
      const json = await inner.get(url);
      record.set(url, json);
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
    prop: "imageinfo|templates",
    iiprop: "timestamp|url|size|mime|extmetadata",
    iiurlwidth: String(PHOTO_WIDTH),
    iiextmetadatafilter: "Artist|LicenseShortName|LicenseUrl|AttributionRequired|NonFree|ImageDescription|ObjectName",
    // Only the deletion tags: at most 50 files × 6 tags, well inside one response.
    tltemplates: DELETION_TEMPLATES.join("|"),
    tllimit: "max",
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
      const titles = files.map(fileTitle).filter((t): t is string => t !== null);
      if (titles.length) out.set(id, titles);
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
  /** When the current version was uploaded, as Commons gives it (ISO 8601); null when it doesn't. */
  uploadedAt: string | null;
  /** The deletion tags on its page (DELETION_TEMPLATES): a file tagged for deletion isn't shown. */
  deletionTags: string[];
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
        pages?: {
          title?: string;
          missing?: boolean;
          invalid?: boolean;
          templates?: { title?: unknown }[];
          imageinfo?: { timestamp?: unknown; mime?: string; thumburl?: string; thumbwidth?: number; thumbheight?: number; descriptionurl?: string; extmetadata?: Record<string, { value?: unknown }> }[];
        }[];
      };
      continue?: { tlcontinue?: unknown };
    };
    const byTitle = new Map<string, CommonsFile>();
    for (const page of resp.query?.pages ?? []) {
      const info = page.imageinfo?.[0];
      if (!page.title || page.missing || page.invalid || !info?.thumburl || !info.descriptionurl) continue;
      const meta: Record<string, string> = {};
      for (const [k, v] of Object.entries(info.extmetadata ?? {})) if (typeof v?.value === "string") meta[k] = v.value;
      const tags = (Array.isArray(page.templates) ? page.templates : []).map((t) => t?.title).filter((t): t is string => typeof t === "string");
      // An answer cut off in the tags could leave out a file's, so every file in it counts as tagged.
      // (A lone file with older versions also gets a `continue`, for imageinfo: that one is fine.)
      if (resp.continue?.tlcontinue !== undefined) tags.push("(tags incomplete)");
      byTitle.set(page.title, {
        title: page.title,
        mime: info.mime ?? "",
        thumbUrl: info.thumburl,
        thumbWidth: info.thumbwidth ?? 0,
        thumbHeight: info.thumbheight ?? 0,
        descriptionUrl: info.descriptionurl,
        uploadedAt: typeof info.timestamp === "string" ? info.timestamp : null,
        deletionTags: tags,
        meta,
      });
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
 * A file name as a Commons title ("File:…"), or null when it holds a character no title can: one
 * rule for every source, since a "|" would split a batched request into extra titles.
 */
function fileTitle(name: string): string | null {
  const t = name.replace(/_/g, " ").trim();
  return t && !/[|#<>[\]{}\u0000-\u001f\u007f]/.test(t) ? `File:${t}` : null;
}

/**
 * The Commons file a link or tag names, as a title: "File:X.jpg" (the wikimedia_commons tag), a
 * commons.wikimedia.org/wiki/File:X page, or an upload.wikimedia.org original or thumbnail. Null for
 * anything else: a photo elsewhere comes with no license we can check.
 */
export function commonsTitleFrom(ref: string): string | null {
  const s = ref.trim();
  const clean = (name: string) => {
    try {
      return fileTitle(decodeURIComponent(name));
    } catch {
      return null;
    }
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
