import Link from "next/link";
import { PlaceCard } from "../components/PlaceCard";
import { SearchForm } from "../components/SearchForm";
import { areas, runRecommendation } from "../lib/data";
import { MAX_OFFSET } from "@outrn/engine";
import { integer, one, type Search } from "../lib/query";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<Search> }) {
  const query = await searchParams;
  const serviceAreas = await areas();
  const shouldRun = one(query["run"]) === "1";
  const defaults = Object.fromEntries(Object.entries(query).map(([key, value]) => [key, one(value)]));
  const output = shouldRun
    ? await runRecommendation({
        area: one(query["area"]) ?? "les",
        minutes: integer(query["minutes"], 180, 30, 480),
        mode: one(query["mode"]),
        budget: one(query["budget"]),
        mood: one(query["mood"]),
        company: one(query["company"]),
        category: one(query["category"]),
        at: one(query["at"]) || undefined,
        offset: integer(query["offset"], 0, 0, MAX_OFFSET),
      })
    : null;
  // "More options" re-runs the same request one page further, pinned to the first page's instant
  // so the ordering cannot shift underneath the user between pages.
  const pageHref = (offset: number) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(defaults)) if (value !== undefined && key !== "offset" && key !== "at") params.set(key, value);
    if (output) params.set("at", output.context.now.toISOString());
    if (offset > 0) params.set("offset", String(offset));
    return `/?${params.toString()}`;
  };

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
        <SearchForm areas={serviceAreas} defaults={defaults} />
      </section>

      {output ? (
        <section className="results-section" aria-live="polite">
          <div className="results-heading">
            <div>
              <p className="eyebrow">{output.area.name} · {output.context.windowMinutes} minutes</p>
              <h2>{output.offset > 0 ? "More ways out" : output.items.length === 3 ? "Three ways out" : `${output.items.length} honest option${output.items.length === 1 ? "" : "s"}`}</h2>
            </div>
            <Link className="run-link" href={`/ops/runs/${output.runId}`}>Inspect run <span>{output.runId.slice(0, 8)}</span></Link>
          </div>
          <div className="card-grid">
            {output.items.map(({ evaluation, copy }, index) => <PlaceCard key={evaluation.candidate.id} evaluation={evaluation} copy={copy} index={output.offset + index} />)}
          </div>
          {(output.nextOffset !== null || output.offset > 0) && (
            <div className="more-options">
              {output.offset > 0 && <Link className="text-button" href={pageHref(Math.max(0, output.offset - 3))}>← Previous</Link>}
              {output.nextOffset !== null && <Link className="text-button" href={pageHref(output.nextOffset)}>More options →</Link>}
            </div>
          )}
          {output.fewerThanThree && (
            <div className="honest-empty">
              <strong>We won’t pad the answer.</strong>
              <span>{output.relaxations.length ? `Try ${output.relaxations.join(" or ")}.` : "Try a different time."}</span>
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
