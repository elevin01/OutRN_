import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { describeFacts } from "@outrn/engine";
import { place } from "../../../lib/data";
import { one, type Search } from "../../../lib/query";

export const dynamic = "force-dynamic";

const EVIDENCE_LABEL = { published: "published", reported: "reported", estimate: "estimate", missing: "not listed" } as const;
const TRAVEL_MODE: Record<string, string> = { walk: "walking", drive: "driving", transit: "transit" };

function address(tags: Record<string, string>): string | null {
  const street = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ");
  return [street, tags["addr:city"]].filter(Boolean).join(", ") || null;
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const item = await place((await params).id);
  return { title: item?.name ?? "Place" };
}

export default async function PlacePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const item = await place((await params).id);
  if (!item) notFound();
  const mode = TRAVEL_MODE[one((await searchParams)["mode"]) ?? ""] ?? "walking";
  const maps = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${item.lat},${item.lon}`)}&travelmode=${mode}`;
  const site = (item.facts["website"]?.value as { value?: string } | undefined)?.value ?? item.tags["website"];
  const phone = (item.facts["phone"]?.value as { value?: string } | undefined)?.value ?? item.tags["phone"];
  const rows = describeFacts(item.facts, { tz: item.timezone, point: { lat: item.lat, lon: item.lon }, now: new Date() });
  return (
    <section className="detail-shell">
      <Link className="back-link" href="/">← Back to the three</Link>
      <div className="detail-hero">
        <div>
          <p className="eyebrow">{item.category.replaceAll("_", " ")}</p>
          <h1>{item.name}</h1>
          {address(item.tags) && <p className="detail-address">{address(item.tags)}</p>}
        </div>
        <a className="primary-button detail-map" href={maps} target="_blank" rel="noreferrer">Start directions <span>↗</span></a>
      </div>
      <div className="detail-grid">
        <article className="detail-panel">
          <p className="eyebrow">What we know</p>
          <dl className="fact-list">
            {rows.map((row) => (
              <div key={row.attribute} className={row.attribute === "opening_hours" ? "fact-hours" : undefined}>
                <dt>{row.label}</dt>
                <dd>
                  {row.value}
                  {row.detail && <span className="fact-detail">{row.detail}</span>}
                  <small>
                    {[row.source, row.age, EVIDENCE_LABEL[row.evidence]].filter(Boolean).join(" · ")}
                    {row.conflict && <em> · sources disagree</em>}
                  </small>
                </dd>
              </div>
            ))}
          </dl>
        </article>
        <aside className="contact-panel">
          <p className="eyebrow">Before you go</p>
          <h2>Check the source</h2>
          <p>Hours and admission can change. OutRN shows what the evidence supports, not a guarantee.</p>
          {site && <a href={site} target="_blank" rel="noreferrer">Visit website ↗</a>}
          {phone && <a href={`tel:${phone}`}>Call {phone}</a>}
          <a href={maps} target="_blank" rel="noreferrer">Open in Google Maps ↗</a>
        </aside>
      </div>
    </section>
  );
}
