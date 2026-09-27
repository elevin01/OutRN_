import type { Command } from "commander";
import { CONFIRMATION_MAX_AGE_DAYS, PROGRAMME_CATEGORIES } from "@outrn/core";
import { audit, getDb } from "@outrn/db";
import { materializeSubjects } from "@outrn/facts";
import { confirmSplit, mergeVenues } from "@outrn/identity";
import { registerSite, runFirstParty } from "@outrn/ingest";

/**
 * The two founder queues and the health strip, as commands. The web ops screens call the same
 * functions.
 */
export function registerOps(program: Command): void {
  const ops = program.command("ops").description("Founder queues: exceptions, conflicts, health");

  ops
    .command("queue")
    .description("Candidates and exceptions: review-flagged identity matches, missing essentials, failed sites")
    .action(async () => {
      const db = getDb();
      const review = await db.query<{ venue: string; category: string; candidate: string; score: string; evidence: unknown; source_entity_id: string }>(
        `select v.canonical_name as venue, v.category, c.canonical_name as candidate, l.score, l.evidence, l.source_entity_id
           from entity_links l join venues v on v.id = l.venue_id join venues c on c.id = (l.evidence->>'candidate')::uuid
          where l.decision = 'review' and l.superseded_by is null order by l.score desc limit 50`,
      );
      console.log(`identity review (${review.rowCount}):`);
      for (const r of review.rows) console.log(`  ${r.venue} [${r.category}]  ≈  ${r.candidate}   score ${r.score}   se=${r.source_entity_id}`);
      const missing = await db.query<{ id: string; name: string; category: string; missing: string[] }>(
        `select v.id, v.canonical_name as name, v.category,
                array_remove(array[
                  case when not exists (select 1 from current_facts cf where cf.subject_id = v.id and cf.attribute = 'opening_hours') then 'hours' end,
                  case when not exists (select 1 from current_facts cf where cf.subject_id = v.id and cf.attribute = 'price') then 'price' end
                ], null) as missing
           from venues v where v.publish_state = 'eligible'
          order by v.canonical_name limit 400`,
      );
      const rows = missing.rows.filter((r) => r.missing.length);
      console.log(`\neligible venues missing essentials (${rows.length}):`);
      for (const r of rows.slice(0, 40)) console.log(`  ${r.name.padEnd(34)} ${r.category.padEnd(12)} missing ${r.missing.join(", ").padEnd(12)} ${r.id}`);
      if (rows.length > 40) console.log(`  … ${rows.length - 40} more`);
      if (rows.length) console.log(`  fill with: outrn facts set <id> opening_hours "Mo-Su 16:00-02:00" --evidence "called 9/27"`);
      const programme = await db.query<{ id: string; name: string; category: string; website: string | null }>(
        `select v.id, v.canonical_name as name, v.category,
                (select cf.value->>'value' from current_facts cf where cf.subject_kind = 'venue' and cf.subject_id = v.id and cf.attribute = 'website') as website
           from venues v
          where v.publish_state = 'eligible' and v.category = any($1::text[])
            and not exists (select 1 from firstparty_sites s where s.venue_id = v.id and s.enabled)
          order by v.canonical_name`,
        [[...PROGRAMME_CATEGORIES]],
      );
      console.log(`\nprogramme venues with no showtimes source (${programme.rowCount}) — never shown until one is registered:`);
      for (const r of programme.rows) {
        console.log(`  ${r.name.padEnd(34)} ${r.category.padEnd(12)} ${r.id}`);
        console.log(`    outrn firstparty add ${r.id} ${r.website ?? "<showtimes-url>"} --reason "showtimes"`);
      }
      // Recheck policy: a founder check holds CONFIRMATION_MAX_AGE_DAYS; older or disputed material facts come back here.
      const recheck = await db.query<{ id: string; name: string; attribute: string; verified: Date; conflict: boolean }>(
        `select v.id, v.canonical_name as name, cf.attribute, max(f.source_updated_at) as verified, cf.conflict
           from current_facts cf
           join venues v on v.id = cf.subject_id and v.publish_state = 'eligible'
           join facts f on f.id = any(cf.input_fact_ids) and f.source_id = 'founder'
          where cf.subject_kind = 'venue' and cf.attribute = any($1::text[])
          group by v.id, v.canonical_name, cf.attribute, cf.conflict
         having max(f.source_updated_at) < now() - make_interval(days => $2) or cf.conflict
          order by max(f.source_updated_at) limit 60`,
        [["opening_hours", "admission", "business_status"], CONFIRMATION_MAX_AGE_DAYS],
      );
      console.log(`\nfounder checks due for recheck (${recheck.rowCount}) — older than ${CONFIRMATION_MAX_AGE_DAYS} days or disputed; no longer shown as confirmed:`);
      for (const r of recheck.rows) {
        console.log(`  ${r.name.padEnd(34)} ${r.attribute.padEnd(16)} checked ${r.verified.toISOString().slice(0, 10)}${r.conflict ? " · DISPUTED" : ""}  ${r.id}`);
      }
      if (recheck.rowCount) console.log(`  re-check with: outrn facts set <id> <attribute> <value> --evidence "called <date>"`);
      const sites = await db.query<{ url: string; last_status: string }>(`select url, last_status from firstparty_sites where enabled and last_status is not null and last_status <> 'ok' order by last_fetched_at desc limit 20`);
      console.log(`\nfirst-party sites not ok (${sites.rowCount}):`);
      for (const r of sites.rows) console.log(`  ${r.url} → ${r.last_status}`);
    });

  ops
    .command("conflicts")
    .description("Conflicts and reports: disagreeing facts, open reports, top verification tasks")
    .action(async () => {
      const db = getDb();
      const conflicts = await db.query<{ name: string; attribute: string; source_ids: string[]; confidence: string }>(
        `select v.canonical_name as name, cf.attribute, cf.source_ids, cf.confidence from current_facts cf join venues v on v.id = cf.subject_id where cf.conflict order by cf.confidence limit 40`,
      );
      console.log(`conflicting facts (${conflicts.rowCount}):`);
      for (const r of conflicts.rows) console.log(`  ${r.name.padEnd(34)} ${r.attribute.padEnd(16)} ${r.source_ids.join(",")}  conf ${r.confidence}`);
      const reports = await db.query<{ name: string; issue: string; evidence: string | null; created_at: Date }>(
        `select v.canonical_name as name, r.issue, r.evidence, r.created_at from reports r join venues v on v.id = r.subject_id where r.status = 'open' order by r.created_at limit 40`,
      );
      console.log(`\nopen reports (${reports.rowCount}):`);
      for (const r of reports.rows) console.log(`  ${r.created_at.toISOString().slice(0, 10)}  ${r.name.padEnd(30)} ${r.issue}${r.evidence ? `  — ${r.evidence}` : ""}`);
      const tasks = await db.query<{ name: string; attribute: string; question: string; priority: string }>(
        `select v.canonical_name as name, t.attribute, t.question, t.priority from verification_tasks t join venues v on v.id = t.subject_id where t.resolved_at is null order by t.priority desc limit 15`,
      );
      console.log(`\ntop verification tasks (${tasks.rowCount} shown):`);
      for (const r of tasks.rows) console.log(`  ${r.priority}  ${r.name.padEnd(30)} ${r.attribute.padEnd(16)} ${r.question}`);
    });

  ops
    .command("health")
    .description("Health strip: connectors, recent runs, expired facts, coverage of the last runs")
    .action(async () => {
      const db = getDb();
      const sources = await db.query<{ id: string; enabled: boolean; kill_switch: boolean; open_conditions: string[] }>(`select id, enabled, kill_switch, open_conditions from source_policies order by id`);
      console.log("sources:");
      for (const s of sources.rows) console.log(`  ${s.id.padEnd(16)} ${s.kill_switch ? "KILLED " : s.enabled ? "enabled " : "disabled"} ${s.open_conditions.length ? `· ${s.open_conditions.length} open condition(s)` : ""}`);
      const runs = await db.query<{ source_id: string; kind: string; status: string; started_at: Date; counts: unknown; error: string | null }>(`select source_id, kind, status, started_at, counts, error from ingestion_runs order by started_at desc limit 8`);
      console.log("\nrecent runs:");
      for (const r of runs.rows) console.log(`  ${r.started_at.toISOString()}  ${r.source_id.padEnd(12)} ${r.kind.padEnd(16)} ${r.status.padEnd(9)} ${r.error ?? JSON.stringify(r.counts)}`);
      const expired = await db.query<{ n: string }>(`select count(*) as n from current_facts where valid_until is not null and valid_until < now()`);
      const stale = await db.query<{ n: string }>(`select count(*) as n from current_facts where attribute = 'opening_hours' and confidence < 0.4`);
      const venues = await db.query<{ publish_state: string; n: string }>(`select publish_state, count(*) as n from venues group by 1 order by 1`);
      console.log(`\nvenues: ${venues.rows.map((v) => `${v.publish_state} ${v.n}`).join(" · ")}`);
      console.log(`current_facts past validity (should be 0 after a materialize): ${expired.rows[0]!.n}`);
      console.log(`venues with low-confidence hours: ${stale.rows[0]!.n}`);
      const rr = await db.query<{ n: string; fewer: string; avg_ms: string }>(`select count(*) as n, count(*) filter (where jsonb_array_length(shortlist) < 3) as fewer, round(avg(duration_ms)) as avg_ms from recommendation_runs where created_at > now() - interval '7 days'`);
      const r = rr.rows[0]!;
      console.log(`recommendation runs, last 7 days: ${r.n} · fewer than three: ${r.fewer} · avg ${r.avg_ms ?? 0} ms`);
    });

  ops
    .command("merge <fromVenueId> <intoVenueId>")
    .description("Merge one venue into another (reversible; audited)")
    .requiredOption("--reason <text>")
    .action(async (from: string, into: string, o: { reason: string }) => {
      const db = getDb();
      await mergeVenues(db, from, into, "cli", o.reason);
      await materializeSubjects(db, "venue", [into]);
      console.log(`merged ${from} → ${into}`);
    });

  ops
    .command("split <sourceEntityId>")
    .description("Confirm a review-flagged record is a different place")
    .requiredOption("--reason <text>")
    .action(async (se: string, o: { reason: string }) => {
      await confirmSplit(getDb(), se, "cli", o.reason);
      console.log(`confirmed split for ${se}`);
    });

  ops
    .command("override <venueId> <boost|exclude|review>")
    .description("Founder control on a venue; weight applies to boost")
    .requiredOption("--reason <text>")
    .option("--weight <n>", "appeal delta for boost", parseFloat, 0.1)
    .action(async (venueId: string, kind: string, o: { reason: string; weight: number }) => {
      const db = getDb();
      await db.query(`insert into venue_overrides (venue_id, kind, weight, reason, owner) values ($1,$2,$3,$4,'cli')`, [venueId, kind, kind === "boost" ? o.weight : 0, o.reason]);
      await audit(db, { actor: "cli", action: `override.${kind}`, targetKind: "venue", targetId: venueId, after: { reason: o.reason, weight: o.weight } });
      await materializeSubjects(db, "venue", [venueId]);
      console.log(`${kind} recorded for ${venueId}`);
    });

  const fp = program.command("firstparty").description("First-party site registry and extraction");
  fp.command("add <venueId> <url>")
    .requiredOption("--reason <text>", "why this page: hours page, events calendar, homepage")
    .action(async (venueId: string, url: string, o: { reason: string }) => {
      await registerSite(getDb(), venueId, url, o.reason);
      console.log(`registered ${url}`);
    });
  fp.command("run")
    .description("Fetch due sites, extract JSON-LD, write facts and occurrences")
    .option("--limit <n>", "max sites this run", (v) => parseInt(v, 10), 50)
    .option("--force", "ignore fetch intervals")
    .action(async (o: { limit: number; force?: boolean }) => {
      const s = await runFirstParty(getDb(), { limit: o.limit, force: o.force ?? false, log: (l) => console.log(l) });
      console.log(`sites ${s.sites} · ok ${s.ok} · no JSON-LD ${s.noJsonLd} · blocked ${s.blocked} · failed ${s.failed} · facts ${s.facts} · occurrences ${s.occurrences}`);
    });
}
