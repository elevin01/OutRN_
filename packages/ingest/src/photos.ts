import { assertSourceAllowed, getArea, loadParkingRule, withTx, type Db } from "@outrn/db";
import {
  commonsFiles,
  commonsTitleFrom,
  finishRun,
  liveWikimediaFetcher,
  loadWikimediaCapture,
  replayWikimediaFetcher,
  saveWikimediaCapture,
  startRun,
  wikidataImages,
  type CommonsFile,
  type JsonFetcher,
} from "@outrn/sources";
import { ingestExtentFor } from "./pipeline.js";

/**
 * Free photos of venues from Wikimedia Commons. A venue's photos come from what its OSM records name:
 * a Commons file (wikimedia_commons, or an image link to Commons), then its Wikidata item's image
 * (P18). Only freely licensed photos are kept (public domain, CC0, CC BY, CC BY-SA), each with the
 * credit its license requires. Nothing else is guessed: no search by name, no photo of "a place like
 * this".
 */

/** Photos kept per venue, the lead first. */
export const MAX_PHOTOS_PER_VENUE = 3;

export interface VenuePhoto {
  title: string;
  url: string;
  width: number;
  height: number;
  author: string | null;
  license: string;
  licenseUrl: string | null;
  sourceUrl: string;
  alt: string | null;
  /** How the photo is tied to the venue: "osm:wikimedia_commons", "osm:image", "wikidata:P18". */
  via: string;
}

const PHOTO_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Plain text from Commons' HTML metadata: tags dropped, entities decoded, whitespace collapsed. */
export function plainText(html: string | undefined, max: number): string | null {
  if (!html) return null;
  const text = html
    .replace(/<\s*(br|\/?(p|div|li|tr|td|dd|dt))\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e: string) => {
      const k = e.toLowerCase();
      if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16));
      if (k.startsWith("#")) return String.fromCodePoint(parseInt(k.slice(1), 10));
      return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[k] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Licenses a photo may be shown under, with what each asks for. */
function licenseOf(meta: Record<string, string>): { name: string; needsCredit: boolean } | null {
  if (meta["NonFree"] && meta["NonFree"].toLowerCase() === "true") return null;
  const name = (meta["LicenseShortName"] ?? "").trim();
  if (/^(public domain|pd(-[\w-]+)?)$/i.test(name)) return { name: "Public domain", needsCredit: false };
  if (/^cc0( 1\.0)?$/i.test(name)) return { name: "CC0", needsCredit: false };
  if (/^cc by(-sa)? \d\.\d( [a-z-]{2,})?$/i.test(name)) return { name: name.replace(/^cc by/i, "CC BY").replace(/-sa/i, "-SA"), needsCredit: true };
  return null;
}

function httpsUrl(raw: string | undefined, hosts: RegExp): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    if (u.protocol === "http:") u.protocol = "https:";
    return u.protocol === "https:" && !u.username && !u.password && hosts.test(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * A Commons file as a photo we may show, or null: a photo (not a drawing, map or logo), freely
 * licensed, credited as its license requires, served from Wikimedia's own hosts.
 */
export function photoFrom(f: CommonsFile, via: string): VenuePhoto | null {
  if (!PHOTO_MIME.has(f.mime)) return null;
  const license = licenseOf(f.meta);
  if (!license) return null;
  const author = plainText(f.meta["Artist"], 200);
  if (license.needsCredit && !author) return null;
  const url = httpsUrl(f.thumbUrl, /^upload\.wikimedia\.org$/);
  const sourceUrl = httpsUrl(f.descriptionUrl, /^commons\.wikimedia\.org$/);
  if (!url || !sourceUrl || f.thumbWidth < 1 || f.thumbHeight < 1) return null;
  const licenseUrl = httpsUrl(f.meta["LicenseUrl"], /^(creativecommons\.org|commons\.wikimedia\.org|en\.wikipedia\.org)$/);
  const alt = plainText(f.meta["ImageDescription"], 200) ?? plainText(f.meta["ObjectName"], 200);
  return { title: f.title, url, width: f.thumbWidth, height: f.thumbHeight, author, license: license.name, licenseUrl, sourceUrl, alt, via };
}

/** The Commons files a venue's OSM tags name directly, in the mapper's order. */
export function taggedFiles(tags: Record<string, string>): { title: string; via: string }[] {
  const out: { title: string; via: string }[] = [];
  for (const ref of (tags["wikimedia_commons"] ?? "").split(";")) {
    const title = /^(File|Image):/i.test(ref.trim()) ? commonsTitleFrom(ref) : null;
    if (title) out.push({ title, via: "osm:wikimedia_commons" });
  }
  for (const ref of (tags["image"] ?? "").split(";")) {
    const title = commonsTitleFrom(ref);
    if (title) out.push({ title, via: "osm:image" });
  }
  return out;
}

export interface PhotoIngestOptions {
  areaSlug: string;
  /** Replay a saved capture instead of fetching. */
  fromFile?: string;
  /** Record every response for later replay (live runs only). */
  saveTo?: string;
  /** Override the derived extent, metres from the area center. */
  radiusM?: number;
  clock?: () => Date;
  log?: (line: string) => void;
}

export interface PhotoIngestSummary {
  runId: string;
  area: string;
  /** Venues in the extent whose OSM records name a Commons file or a Wikidata item. */
  venues: number;
  withPhotos: number;
  photos: number;
  /** Files found but not usable: not free, uncredited, not a photo, or missing. */
  skipped: number;
}

interface VenueRefs {
  id: string;
  name: string;
  files: { title: string; via: string }[];
  wikidata: string[];
}

/** Every eligible venue in the area's extent, with the Commons files and Wikidata items its OSM records name. */
async function venueRefs(db: Db, center: { lat: number; lon: number }, radiusM: number): Promise<VenueRefs[]> {
  const rows = (
    await db.query<{ id: string; name: string; tags: Record<string, string> }>(
      `select v.id, v.canonical_name as name, se.raw->'tags' as tags
         from venues v
         join entity_links l on l.venue_id = v.id and l.superseded_by is null
         join source_entities se on se.id = l.source_entity_id and se.source_id = 'osm' and se.deleted_at is null
        where v.publish_state = 'eligible'
          and ST_DWithin(v.geom, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
          and se.raw->'tags' ?| array['wikidata', 'wikimedia_commons', 'image']
        order by v.id, se.external_id`,
      [center.lon, center.lat, radiusM],
    )
  ).rows;
  const byVenue = new Map<string, VenueRefs>();
  for (const r of rows) {
    const v = byVenue.get(r.id) ?? { id: r.id, name: r.name, files: [], wikidata: [] };
    v.files.push(...taggedFiles(r.tags));
    const q = r.tags["wikidata"]?.trim();
    if (q && /^Q[1-9]\d{0,11}$/.test(q) && !v.wikidata.includes(q)) v.wikidata.push(q);
    byVenue.set(r.id, v);
  }
  return [...byVenue.values()];
}

export async function ingestPhotos(db: Db, opts: PhotoIngestOptions): Promise<PhotoIngestSummary> {
  const log = opts.log ?? (() => undefined);
  const area = await getArea(db, opts.areaSlug);
  if (!opts.fromFile) await assertSourceAllowed(db, "wikimedia", "fetch");
  const radiusM = opts.radiusM ?? ingestExtentFor(area, await loadParkingRule(db, area.slug)).radiusM;
  const runId = await startRun(db, { sourceId: "wikimedia", areaId: area.id, kind: opts.fromFile ? "replay" : "commons_photos", params: { radius_m: radiusM, from_file: opts.fromFile ?? null } });
  try {
    const record = opts.saveTo && !opts.fromFile ? new Map<string, unknown>() : undefined;
    const fetcher: JsonFetcher = opts.fromFile ? replayWikimediaFetcher(await loadWikimediaCapture(opts.fromFile)) : liveWikimediaFetcher(record);
    const now = (opts.clock ?? (() => new Date()))();

    const venues = await venueRefs(db, { lat: area.lat, lon: area.lon }, radiusM);
    log(`${venues.length} venues name a Commons file or a Wikidata item`);
    const images = await wikidataImages(fetcher, venues.flatMap((v) => v.wikidata));
    for (const v of venues) for (const q of v.wikidata) for (const title of images.get(q) ?? []) v.files.push({ title, via: "wikidata:P18" });
    const files = await commonsFiles(fetcher, venues.flatMap((v) => v.files.map((f) => f.title)));

    let skipped = 0;
    const rows: { venueId: string; rank: number; p: VenuePhoto }[] = [];
    for (const v of venues) {
      const seen = new Set<string>();
      let rank = 0;
      for (const ref of v.files) {
        if (rank >= MAX_PHOTOS_PER_VENUE) break;
        const f = files.get(ref.title);
        if (!f || seen.has(f.title)) {
          if (!f) skipped++;
          continue;
        }
        seen.add(f.title);
        const p = photoFrom(f, ref.via);
        if (!p) {
          skipped++;
          continue;
        }
        rows.push({ venueId: v.id, rank: rank++, p });
      }
    }

    // The extent's photos are replaced as a whole: a tag removed upstream, or a file relicensed or
    // deleted on Commons, takes its photo along.
    await withTx(db, async (tx) => {
      await tx.query(
        `delete from venue_photos p using venues v
          where v.id = p.venue_id and p.source_id = 'wikimedia'
            and ST_DWithin(v.geom, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)`,
        [area.lon, area.lat, radiusM],
      );
      if (rows.length) {
        await tx.query(
          `insert into venue_photos (venue_id, source_id, file_title, rank, url, width, height, author, license, license_url, source_url, alt, via, fetched_at)
           select d.venue_id, 'wikimedia', d.title, d.rank, d.url, d.width, d.height, d.author, d.license, d.license_url, d.source_url, d.alt, d.via, $13
             from unnest($1::uuid[], $2::text[], $3::int[], $4::text[], $5::int[], $6::int[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[])
                  as d(venue_id, title, rank, url, width, height, author, license, license_url, source_url, alt, via)`,
          [
            rows.map((r) => r.venueId), rows.map((r) => r.p.title), rows.map((r) => r.rank), rows.map((r) => r.p.url), rows.map((r) => r.p.width), rows.map((r) => r.p.height),
            rows.map((r) => r.p.author), rows.map((r) => r.p.license), rows.map((r) => r.p.licenseUrl), rows.map((r) => r.p.sourceUrl), rows.map((r) => r.p.alt), rows.map((r) => r.p.via), now,
          ],
        );
      }
    });
    if (record && opts.saveTo) await saveWikimediaCapture(opts.saveTo, record);
    const withPhotos = new Set(rows.map((r) => r.venueId)).size;
    const summary: PhotoIngestSummary = { runId, area: area.slug, venues: venues.length, withPhotos, photos: rows.length, skipped };
    await finishRun(db, runId, { status: "succeeded", counts: { venues: summary.venues, with_photos: withPhotos, photos: rows.length, skipped } });
    return summary;
  } catch (e) {
    await finishRun(db, runId, { status: "failed", error: (e as Error).message });
    throw e;
  }
}
