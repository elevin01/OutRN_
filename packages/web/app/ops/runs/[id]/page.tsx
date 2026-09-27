import Link from "next/link";
import { notFound } from "next/navigation";
import { recommendationRun } from "../../../../lib/data";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const run = await recommendationRun((await params).id);
  if (!run) notFound();
  const counts = run.results.reduce<Record<string, number>>((all, item) => ({ ...all, [item.class]: (all[item.class] ?? 0) + 1 }), {});
  return (
    <section className="ops-shell">
      <Link className="back-link" href="/ops/eligible">← Eligible now</Link>
      <div className="run-hero">
        <div><p className="eyebrow">Persisted recommendation run</p><h1>{run.area ?? "Custom origin"}</h1><code>{run.id}</code></div>
        <div className="run-meta"><span>{run.createdAt.toISOString()}</span><span>engine {run.engineVersion}</span><span>weights {run.weightsVersion}</span></div>
      </div>
      <div className="metric-strip">
        <div><strong>{run.candidateCount}</strong><span>candidates</span></div>
        <div><strong>{counts["ready"] ?? 0}</strong><span>ready</span></div>
        <div><strong>{counts["check_first"] ?? 0}</strong><span>check first</span></div>
        <div><strong>{counts["ineligible"] ?? 0}</strong><span>ineligible</span></div>
        <div><strong>{run.durationMs ?? "—"}ms</strong><span>engine time</span></div>
      </div>
      <details className="context-block"><summary>Request context</summary><pre>{JSON.stringify(run.context, null, 2)}</pre></details>
      <div className="decision-table-wrap">
        <table className="decision-table">
          <thead><tr><th>Place</th><th>Class</th><th>Travel</th><th>Useful</th><th>Decision</th><th>Scores</th></tr></thead>
          <tbody>
            {run.results.map((item) => (
              <tr key={item.item_id} className={run.shortlistIds.includes(item.item_id) ? "shortlisted-row" : undefined}>
                <td><Link href={item.item_kind === "venue" ? `/places/${item.item_id}` : "#"}>{item.name}</Link><small>{item.category}{run.shortlistIds.includes(item.item_id) ? " · shortlisted" : ""}</small></td>
                <td><span className={`status-pill ${item.class}`}>{item.class.replace("_", " ")}</span></td>
                <td>{item.travel_minutes === null ? "—" : `${item.travel_minutes} min`}</td>
                <td>{item.useful_minutes === null ? "—" : `${item.useful_minutes} min`}</td>
                <td className="code-cell">{item.excluded_by ?? (item.unresolved.join(", ") || "PASS")}</td>
                <td className="score-cell">E {item.scores["evidence"] ?? 0} · F {item.scores["fit"] ?? 0} · A {item.scores["appeal"] ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
