import type { Photo } from "@outrn/contracts";
import type { Queryable } from "@outrn/db";

/** Where each photo source is credited: "…, via Wikimedia Commons". */
const VIA: Record<string, string> = { wikimedia: "Wikimedia Commons" };

/** The photos of these venues, lead first, at most `perVenue` each, with the credit each license requires. */
export async function loadPhotos(q: Queryable, venueIds: readonly string[], perVenue: number): Promise<Map<string, Photo[]>> {
  const out = new Map<string, Photo[]>();
  if (!venueIds.length) return out;
  const rows = (
    await q.query<{ venue_id: string; source_id: string; url: string; width: number; height: number; author: string | null; license: string; license_url: string | null; source_url: string; alt: string | null }>(
      `select venue_id, source_id, url, width, height, author, license, license_url, source_url, alt
         from venue_photos where venue_id = any($1::uuid[]) and rank < $2
        order by venue_id, source_id, rank`,
      [venueIds, perVenue],
    )
  ).rows;
  for (const r of rows) {
    const list = out.get(r.venue_id) ?? [];
    if (list.length >= perVenue) continue;
    const via = VIA[r.source_id] ?? r.source_id;
    list.push({ url: r.url, width: r.width, height: r.height, alt: r.alt, credit: [r.author, r.license, `via ${via}`].filter(Boolean).join(", "), author: r.author, license: r.license, licenseUrl: r.license_url, sourceUrl: r.source_url });
    out.set(r.venue_id, list);
  }
  return out;
}

/** The sources behind photos, for the response's attributions. */
export async function photoSources(q: Queryable, venueIds: readonly string[]): Promise<string[]> {
  if (!venueIds.length) return [];
  return (await q.query<{ source_id: string }>(`select distinct source_id from venue_photos where venue_id = any($1::uuid[])`, [venueIds])).rows.map((r) => r.source_id);
}
