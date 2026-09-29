import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { PlaceDetails, TravelMode } from "@outrn/contracts";
import { ApiProblem } from "../../../components/ApiProblem";
import { CategoryIcon } from "../../../components/CategoryIcon";
import { PhotoFigure } from "../../../components/PhotoFigure";
import { photosFor } from "../../../lib/categories";
import { api, ApiRequestError } from "../../../lib/api";
import { one, type Search } from "../../../lib/query";

export const dynamic = "force-dynamic";

const MODES: TravelMode[] = ["walk", "transit", "drive"];

async function load(id: string): Promise<PlaceDetails | ApiRequestError> {
  try {
    return await api.place(id);
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === "NOT_FOUND") notFound();
    if (error instanceof ApiRequestError) return error;
    throw error;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const item = await load((await params).id);
  return { title: item instanceof ApiRequestError ? "Place" : item.name };
}

export default async function PlacePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const item = await load((await params).id);
  if (item instanceof ApiRequestError) return <section className="detail-shell"><Link className="back-link" href="/">← Back to the three</Link><ApiProblem error={item} /></section>;
  const requested = one((await searchParams)["mode"]);
  const mode = MODES.find((m) => m === requested) ?? "walk";
  const maps = item.actions.directionsUrls[mode];
  const { websiteUrl: site, phone } = item.contact;
  const photos = photosFor(item.name, item.category, item.photos);
  const fallback = photosFor(item.name, item.category, [])[0];
  return (
    <section className="detail-shell">
      <Link className="back-link" href="/">← Back to the three</Link>
      {photos.length > 0 ? (
        <div className="detail-photos">
          {photos.map((p) => (
            <PhotoFigure key={p.url} photo={p} fallback={fallback} category={item.category.id} />
          ))}
        </div>
      ) : (
        <div className="detail-photos">
          <PhotoFigure photo={undefined} category={item.category.id} />
        </div>
      )}
      <div className="detail-hero">
        <div>
          <p className="eyebrow category-line"><CategoryIcon category={item.category.id} size={14} />{item.category.label}</p>
          <h1>{item.name}</h1>
          {item.address && <p className="detail-address">{item.address}</p>}
        </div>
        <a className="primary-button detail-map" href={maps} target="_blank" rel="noreferrer">Start directions <span>↗</span></a>
      </div>
      <div className="detail-grid">
        <article className="detail-panel">
          <p className="eyebrow">What we know</p>
          <dl className="fact-list">
            {item.facts.map((row) => (
              <div key={row.attribute} className={row.attribute === "opening_hours" ? "fact-hours" : undefined}>
                <dt>{row.label}</dt>
                <dd>
                  {row.value}
                  {row.detail && <span className="fact-detail">{row.detail}</span>}
                  <small>
                    {row.provenance.summary}
                    {row.provenance.conflict && <em> · sources disagree</em>}
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
