import Link from "next/link";
import { SearchForm } from "../../../components/SearchForm";
import { areas, recentRuns, runRecommendation } from "../../../lib/data";
import { integer, one, type Search } from "../../../lib/query";

export const dynamic = "force-dynamic";

export default async function EligiblePage({ searchParams }: { searchParams: Promise<Search> }) {
  const query = await searchParams;
  const serviceAreas = await areas();
  const defaults = Object.fromEntries(Object.entries(query).map(([key, value]) => [key, one(value)]));
  const output = one(query["run"]) === "1"
    ? await runRecommendation({
        area: one(query["area"]) ?? "les",
        minutes: integer(query["minutes"], 180, 30, 480),
        mode: one(query["mode"]),
        budget: one(query["budget"]),
        mood: one(query["mood"]),
        category: one(query["category"]),
        at: one(query["at"]) || undefined,
      })
    : null;
  const runs = await recentRuns();
  const counts = output?.all.reduce<Record<string, number>>((all, item) => ({ ...all, [item.class]: (all[item.class] ?? 0) + 1 }), {}) ?? {};

  return (
    <section className="ops-shell">
      <div className="ops-heading">
        <div><p className="eyebrow">Operations / 01</p><h1>Eligible right now</h1></div>
        <p>Run the same deterministic gate the consumer sees, inspect every candidate, and open persisted runs without touching SQL.</p>
      </div>
      <SearchForm areas={serviceAreas} defaults={defaults} ops />

      {output && (
        <div className="debug-output">
          <div className="metric-strip">
            <div><strong>{output.all.length}</strong><span>candidates</span></div>
            <div><strong>{counts["ready"] ?? 0}</strong><span>ready</span></div>
            <div><strong>{counts["check_first"] ?? 0}</strong><span>check first</span></div>
            <div><strong>{counts["ineligible"] ?? 0}</strong><span>ineligible</span></div>
            <div><strong>{output.durationMs}ms</strong><span>engine time</span></div>
          </div>
          <div className="debug-title"><h2>Candidate decisions</h2><Link href={`/ops/runs/${output.runId}`}>Open persisted run ↗</Link></div>
          <div className="decision-table-wrap">
            <table className="decision-table">
              <thead><tr><th>Place</th><th>Class</th><th>Travel</th><th>Useful</th><th>Decision</th><th>Scores</th></tr></thead>
              <tbody>
                {[...output.all].sort((a, b) => a.class.localeCompare(b.class)).map((item) => (
                  <tr key={item.candidate.id}>
                    <td><Link href={`/places/${item.candidate.venueId}`}>{item.candidate.name}</Link><small>{item.candidate.category}</small></td>
                    <td><span className={`status-pill ${item.class}`}>{item.class.replace("_", " ")}</span></td>
                    <td>{item.timing ? `${item.timing.travel.minutes} min` : "—"}</td>
                    <td>{item.timing ? `${item.timing.usefulMinutes} min` : "—"}</td>
                    <td className="code-cell">{item.excludedBy ?? (item.unresolved.join(", ") || "PASS")}</td>
                    <td className="score-cell">E {item.scores.evidence} · F {item.scores.fit} · A {item.scores.appeal}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="run-list-block">
        <div className="debug-title"><h2>Recent runs</h2><span>{runs.length} newest</span></div>
        <div className="run-list">
          {runs.map((run) => (
            <Link href={`/ops/runs/${run.id}`} key={run.id}>
              <span className="run-time">{run.createdAt.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
              <strong>{run.area ?? "Custom origin"}</strong>
              <span>{run.candidateCount} candidates · {run.durationMs ?? "—"}ms</span>
              <code>{run.id.slice(0, 8)}</code>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
