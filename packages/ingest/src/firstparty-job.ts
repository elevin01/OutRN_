import type { Attribute, FactInput } from "@outrn/core";
import { assertSourceAllowed, withTx, type Db } from "@outrn/db";
import { materializeSubjects, writeFacts } from "@outrn/facts";
import { fetchAndExtract, finishRun, startRun, FetchBlocked, FetchFailed, type FirstPartyExtraction } from "@outrn/sources";

/**
 * First-party extraction job: for every due site in firstparty_sites, fetch, extract JSON-LD,
 * write venue facts (source 'firstparty', published class) and dated occurrences, then
 * re-materialize the venue. Raw HTML is never stored. Per-host pacing comes from the guarded
 * fetch; the registry's fetch_interval_h decides when a site is due.
 */

export interface FirstPartyRunSummary {
  runId: string;
  sites: number;
  ok: number;
  noJsonLd: number;
  blocked: number;
  failed: number;
  facts: number;
  occurrences: number;
}

interface SiteRow {
  id: string;
  venue_id: string;
  url: string;
  fetch_interval_h: number;
}

export async function registerSite(db: Db, venueId: string, url: string, reason: string): Promise<void> {
  await db.query(
    `insert into firstparty_sites (venue_id, url, reason) values ($1, $2, $3) on conflict (venue_id, url) do update set reason = excluded.reason, enabled = true`,
    [venueId, url, reason],
  );
}

export function factsFromExtraction(x: FirstPartyExtraction, venueId: string): FactInput[] {
  const out: FactInput[] = [];
  for (const f of x.facts) {
    if (f.status === "not_stated") continue;
    out.push({
      subjectKind: "venue",
      subjectId: venueId,
      attribute: f.attribute as Attribute,
      value: f.value,
      evidenceClass: "published",
      sourceId: "firstparty",
      evidence: `${x.url} :: ${f.evidence}`,
      fetchedAt: x.fetchedAt,
      sourceUpdatedAt: null,
      confidence: f.status === "stated" ? 0.85 : 0.5,
      lineageGroup: `firstparty:${new URL(x.url).hostname}`,
    });
  }
  return out;
}

export async function runFirstParty(db: Db, opts: { limit?: number; force?: boolean; log?: (l: string) => void } = {}): Promise<FirstPartyRunSummary> {
  const log = opts.log ?? (() => undefined);
  await assertSourceAllowed(db, "firstparty", "fetch");
  const due = (
    await db.query<SiteRow>(
      `select id, venue_id, url, fetch_interval_h from firstparty_sites
        where enabled and ($2 or last_fetched_at is null or last_fetched_at < now() - (fetch_interval_h || ' hours')::interval)
        order by last_fetched_at nulls first limit $1`,
      [opts.limit ?? 50, opts.force ?? false],
    )
  ).rows;
  const runId = await startRun(db, { sourceId: "firstparty", kind: "firstparty_site", params: { sites: due.length } });
  const s: FirstPartyRunSummary = { runId, sites: due.length, ok: 0, noJsonLd: 0, blocked: 0, failed: 0, facts: 0, occurrences: 0 };
  for (const site of due) {
    let status = "ok";
    try {
      const x = await fetchAndExtract(site.url);
      if (!x.blocks || (!x.facts.length && !x.events.length)) {
        status = "no_jsonld";
        s.noJsonLd++;
      } else {
        await withTx(db, async (tx) => {
          const w = await writeFacts(tx, factsFromExtraction(x, site.venue_id).map((f) => ({ ...f, ingestionRunId: runId })));
          s.facts += w.inserted;
          const kinded: string[] = [];
          for (const ev of x.events) {
            const r = await tx.query<{ id: string }>(
              `insert into occurrences (venue_id, title, start_at, end_at, status, recurrence_key)
               values ($1, $2, $3, $4, $5, $6)
               on conflict (recurrence_key) where recurrence_key is not null do update set end_at = excluded.end_at, status = excluded.status
               returning id`,
              [site.venue_id, ev.title, ev.start, ev.end, ev.status, `${new URL(x.url).hostname}:${ev.title}:${ev.start.toISOString()}`],
            );
            s.occurrences += r.rowCount ?? 0;
            // What the venue's own page says the event is (a MusicEvent is live music): it ranks for taste.
            const id = r.rows[0]?.id;
            if (id && ev.kinds.length) {
              await writeFacts(tx, [{ subjectKind: "occurrence", subjectId: id, attribute: "event_kind", value: { interests: ev.kinds }, evidenceClass: "published", sourceId: "firstparty", evidence: `${x.url} :: ${ev.evidence}`.slice(0, 1200), fetchedAt: x.fetchedAt, sourceUpdatedAt: null, confidence: 0.85, lineageGroup: `firstparty:${new URL(x.url).hostname}` }]);
              kinded.push(id);
            }
          }
          if (kinded.length) await materializeSubjects(tx, "occurrence", kinded);
          await materializeSubjects(tx, "venue", [site.venue_id]);
        });
        s.ok++;
      }
    } catch (e) {
      if (e instanceof FetchBlocked) {
        status = `blocked: ${e.message}`;
        s.blocked++;
      } else {
        status = `error: ${(e as FetchFailed).message.slice(0, 120)}`;
        s.failed++;
      }
    }
    await db.query(`update firstparty_sites set last_fetched_at = now(), last_status = $2 where id = $1`, [site.id, status]);
    log(`  ${site.url} → ${status}`);
  }
  await finishRun(db, runId, { status: s.failed && !s.ok ? "failed" : s.failed ? "partial" : "succeeded", counts: { ...s } as unknown as Record<string, number> });
  return s;
}
