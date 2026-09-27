import Link from "next/link";
import { notFound } from "next/navigation";
import type { OpsRunDetail } from "@outrn/contracts";
import { ApiProblem } from "../../../../components/ApiProblem";
import { api, ApiRequestError } from "../../../../lib/api";
import { requireOps } from "../../../../lib/ops";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const credential = await requireOps();
  let run: OpsRunDetail;
  try {
    run = await api.ops.run(credential, (await params).id);
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === "NOT_FOUND") notFound();
    if (error instanceof ApiRequestError) return <section className="ops-shell"><Link className="back-link" href="/ops/eligible">← Eligible now</Link><ApiProblem error={error} /></section>;
    throw error;
  }
  return (
    <section className="ops-shell">
      <Link className="back-link" href="/ops/eligible">← Eligible now</Link>
      <div className="run-hero">
        <div><p className="eyebrow">Persisted recommendation run</p><h1>{run.areaName ?? "Custom origin"}</h1><code>{run.id}</code></div>
        <div className="run-meta"><span>{run.createdAt}</span><span>engine {run.engineVersion}</span><span>weights {run.weightsVersion}</span></div>
      </div>
      <div className="metric-strip">
        <div><strong>{run.candidateCount}</strong><span>candidates</span></div>
        <div><strong>{run.counts.ready}</strong><span>ready</span></div>
        <div><strong>{run.counts.check_first}</strong><span>check first</span></div>
        <div><strong>{run.counts.ineligible}</strong><span>ineligible</span></div>
        <div><strong>{run.durationMs ?? "—"}ms</strong><span>engine time</span></div>
      </div>
      <details className="context-block"><summary>Request context</summary><pre>{JSON.stringify(run.context, null, 2)}</pre></details>
      <div className="decision-table-wrap">
        <table className="decision-table">
          <thead><tr><th>Place</th><th>Class</th><th>Travel</th><th>Useful</th><th>Decision</th><th>Scores</th></tr></thead>
          <tbody>
            {run.results.map((item) => (
              <tr key={item.itemId} className={item.shortlisted ? "shortlisted-row" : undefined}>
                <td>{item.placeId ? <Link href={`/places/${item.placeId}`}>{item.name}</Link> : item.name}<small>{item.category}{item.shortlisted ? " · shortlisted" : ""}</small></td>
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
    </section>
  );
}
