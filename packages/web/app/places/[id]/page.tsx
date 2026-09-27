import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { place } from "../../../lib/data";

export const dynamic = "force-dynamic";

function valueText(value: unknown): string {
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (typeof object["value"] === "string") return object["value"];
    if (typeof object["osm"] === "string") return object["osm"];
    if (object["free"] === true) return "Free";
    if (typeof object["min"] === "number" || typeof object["max"] === "number") return `$${object["min"] ?? 0}–$${object["max"] ?? object["min"]}`;
    if (typeof object["requirement"] === "string") return String(object["requirement"]).replaceAll("_", " ");
  }
  return JSON.stringify(value);
}

function address(tags: Record<string, string>): string | null {
  const street = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ");
  return [street, tags["addr:city"]].filter(Boolean).join(", ") || null;
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const item = await place((await params).id);
  return { title: item?.name ?? "Place" };
}

export default async function PlacePage({ params }: { params: Promise<{ id: string }> }) {
  const item = await place((await params).id);
  if (!item) notFound();
  const maps = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${item.lat},${item.lon}`)}&travelmode=walking`;
  const site = (item.facts["website"]?.value as { value?: string } | undefined)?.value ?? item.tags["website"];
  const phone = (item.facts["phone"]?.value as { value?: string } | undefined)?.value ?? item.tags["phone"];
  const visibleFacts = Object.entries(item.facts).filter(([key]) => !["name", "category", "website", "phone"].includes(key));
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
            {visibleFacts.map(([key, fact]) => (
              <div key={key}>
                <dt>{key.replaceAll("_", " ")}</dt>
                <dd>{valueText(fact.value)} <small>{Math.round(fact.confidence * 100)}% confidence · {fact.evidenceClass}</small></dd>
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
