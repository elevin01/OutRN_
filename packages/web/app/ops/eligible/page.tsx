import Link from "next/link";
import type { AreasResponse, OpsRunDetail, OpsRunList } from "@outrn/contracts";
import { ApiProblem } from "../../../components/ApiProblem";
import { SearchForm } from "../../../components/SearchForm";
import { api, ApiRequestError } from "../../../lib/api";
import { one, type Search } from "../../../lib/query";
import { requestFromQuery } from "../../../lib/request";

export const dynamic = "force-dynamic";

export default async function EligiblePage({ searchParams }: { searchParams: Promise<Search> }) {
  const query = await searchParams;
  const defaults = Object.fromEntries(Object.entries(query).map(([key, value]) => [key, one(value)]));
  let meta: AreasResponse | null = null;
  let output: OpsRunDetail | null = null;
  let runs: OpsRunList["runs"] = [];
  let failure: ApiRequestError | null = null;
  try {
    meta = await api.areas();
    if (one(query["run"]) === "1") output = await api.ops.evaluate(requestFromQuery(query, meta));
    runs = (await api.ops.runs()).runs;
  } catch (error) {
    if (!(error instanceof ApiRequestError)) throw error;
    failure = error;
  }

  return (
    <section className="ops-shell">
      <div className="ops-heading">
        <div><p className="eyebrow">Operations / 01</p><h1>Eligible right now</h1></div>
        <p>Run the same deterministic gate the consumer sees, inspect every candidate, and open persisted runs without touching SQL.</p>
      </div>
      {meta && <SearchForm meta={meta} defaults={defaults} ops />}
      {failure && <ApiProblem error={failure} />}

      {output && (
        <div className="debug-output">
          <div className="metric-strip">
            <div><strong>{output.counts.total}</strong><span>candidates</span></div>
            <div><strong>{output.counts.ready}</strong><span>ready</span></div>
            <div><strong>{output.counts.check_first}</strong><span>check first</span></div>
            <div><strong>{output.counts.ineligible}</strong><span>ineligible</span></div>
            <div><strong>{output.durationMs ?? "—"}ms</strong><span>engine time</span></div>
          </div>
          <div className="debug-title"><h2>Candidate decisions</h2><Link href={`/ops/runs/${output.id}`}>Open persisted run ↗</Link></div>
          <div className="decision-table-wrap">
            <table className="decision-table">
              <thead><tr><th>Place</th><th>Class</th><th>Travel</th><th>Useful</th><th>Decision</th><th>Scores</th></tr></thead>
              <tbody>
                {[...output.results].sort((a, b) => a.class.localeCompare(b.class)).map((item) => (
                  <tr key={item.itemId}>
                    <td>{item.placeId ? <Link href={`/places/${item.placeId}`}>{item.name}</Link> : item.name}<small>{item.category}</small></td>
                    <td><span className={`status-pill ${item.class}`}>{item.class.replace("_", " ")}</span></td>
                    <td>{item.travelMinutes === null ? "—" : `${item.travelMinutes} min`}</td>
                    <td>{item.usefulMinutes === null ? "—" : `${item.usefulMinutes} min`}</td>
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
              <span className="run-time">{new Date(run.createdAt).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
              <strong>{run.areaName ?? "Custom origin"}</strong>
              <span>{run.candidateCount} candidates · {run.durationMs ?? "—"}ms</span>
              <code>{run.id.slice(0, 8)}</code>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
