import Link from "next/link";
import { redirect } from "next/navigation";
import type { AreasResponse, RecommendationResponse } from "@outrn/contracts";
import { ApiProblem } from "../components/ApiProblem";
import { CategoryShortcuts } from "../components/CategoryShortcuts";
import { PlaceCard } from "../components/PlaceCard";
import { SearchForm } from "../components/SearchForm";
import { api, ApiRequestError } from "../lib/api";
import { one, type Search } from "../lib/query";
import { formFromResolved, hrefForRequest, requestFromQuery } from "../lib/request";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<Search> }) {
  const query = await searchParams;
  let meta: AreasResponse | null = null;
  let output: RecommendationResponse | null = null;
  let failure: ApiRequestError | null = null;
  try {
    meta = await api.areas();
    const cursor = one(query["cursor"]);
    // "More options" and "Previous" carry only a cursor: pages of one frozen result list.
    if (cursor) output = await api.recommendations({ cursor });
    else if (one(query["run"]) === "1") output = await api.recommendations(requestFromQuery(query, meta));
  } catch (error) {
    if (!(error instanceof ApiRequestError)) throw error;
    // The pages' plans went stale: run the same search again, now.
    if (error.code === "CURSOR_EXPIRED" && error.detail?.restart && meta) redirect(hrefForRequest(error.detail.restart, meta));
    failure = error;
  }
  const defaults = output && meta ? formFromResolved(output.request, meta) : Object.fromEntries(Object.entries(query).map(([key, value]) => [key, one(value)]));
  // The shortcuts narrow (or widen) whatever search is on screen, or the default one.
  const base = meta ? requestFromQuery(defaults, meta) : null;

  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <p className="kicker">Free time, solved.</p>
          <h1>Go<br /><span>somewhere</span><br /><em>good.</em></h1>
          <p className="hero-subtitle">Three nearby options that fit the time you actually have. No endless list, no closed doors.</p>
        </div>
        <div className="hero-orbit" aria-hidden="true">
          <div className="orbit-word">OUT</div>
          <div className="orbit-dot one" /><div className="orbit-dot two" /><div className="orbit-dot three" />
        </div>
      </section>

      <section className="finder" aria-labelledby="finder-title">
        <div className="section-heading">
          <div><p className="eyebrow">Make a plan</p><h2 id="finder-title">What fits right now?</h2></div>
          <p>We check travel, hours, useful time, admission, and price before anything earns a card.</p>
        </div>
        {meta && base && <CategoryShortcuts meta={meta} base={base} />}
        {meta && <SearchForm meta={meta} defaults={defaults} />}
      </section>

      {failure ? (
        <section className="results-section" aria-live="polite"><ApiProblem error={failure} /></section>
      ) : output ? (
        <section className="results-section" aria-live="polite">
          <div className="results-heading">
            <div>
              <p className="eyebrow">{output.area.name} · {output.request.windowMinutes} minutes</p>
              <h2>{output.page.offset > 0 ? "More ways out" : output.items.length === 3 ? "Three ways out" : `${output.items.length} honest option${output.items.length === 1 ? "" : "s"}`}</h2>
            </div>
            <Link className="run-link" href={`/ops/runs/${output.requestId}`}>Inspect run <span>{output.requestId.slice(0, 8)}</span></Link>
          </div>
          <div className="card-grid">
            {output.items.map((item, index) => <PlaceCard key={item.id} item={item} index={output.page.offset + index} />)}
          </div>
          {(output.page.nextCursor || output.page.prevCursor) && (
            <div className="more-options">
              {output.page.prevCursor && <Link className="text-button" href={`/?cursor=${output.page.prevCursor}`}>← Previous</Link>}
              {output.page.nextCursor && <Link className="text-button" href={`/?cursor=${output.page.nextCursor}`}>More options →</Link>}
            </div>
          )}
          {output.insufficient && (
            <div className="honest-empty">
              <strong>We won’t pad the answer.</strong>
              <span>{output.insufficient.relaxations.length ? `Try ${output.insufficient.relaxations.map((r) => `${r.text} (+${r.admits})`).join(" or ")}.` : "Try a different time."}</span>
            </div>
          )}
        </section>
      ) : (
        <section className="principles" aria-label="How OutRN works">
          <article><span>01</span><h3>Actually open</h3><p>Arrival time and last entry count. “Open now” isn’t enough.</p></article>
          <article><span>02</span><h3>Enough time</h3><p>Travel and a useful visit fit inside your real window.</p></article>
          <article><span>03</span><h3>Only three</h3><p>A decisive, varied shortlist. Fewer when fewer truly qualify.</p></article>
        </section>
      )}
    </>
  );
}
