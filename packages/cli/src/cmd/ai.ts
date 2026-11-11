import type { Command } from "commander";
import { getDb } from "@outrn/db";
import { aiSettings, clearRenown, planRenown, rateRenown, readEventsWithClaude, recheckEventsWithClaude, spentLastDay, worstCaseCost } from "@outrn/ingest";

export function registerAi(program: Command): void {
  const ai = program.command("ai").description("Claude reads the venues' pages no structured data describes (needs ANTHROPIC_API_KEY; capped by OUTRN_AI_DAILY_BUDGET_USD)");

  ai.command("events")
    .description("Read the events pages of venues that list events no other way; every event checked against the page's own words")
    .option("--limit <n>", "pages this run", (v) => parseInt(v, 10), 10)
    .action(async (o: { limit: number }) => {
      const s = await readEventsWithClaude(getDb(), { limit: o.limit, log: (l) => console.log(l) });
      const skipped = Object.entries(s.skipped).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
      console.log(`pages ${s.pages} · read ${s.read} · events ${s.events} · left out: ${skipped} · $${s.costUsd.toFixed(4)}${s.stoppedForBudget ? " · stopped at the day's cap" : ""}`);
    });

  ai.command("recheck")
    .description("Re-read the pages of events about to start, and mark the ones now cancelled or sold out")
    .option("--limit <n>", "events this run", (v) => parseInt(v, 10), 15)
    .action(async (o: { limit: number }) => {
      const s = await recheckEventsWithClaude(getDb(), { limit: o.limit, log: (l) => console.log(l) });
      console.log(`events ${s.events} · checked ${s.checked} · cancelled ${s.marked.cancelled} · sold out ${s.marked.sold_out} · listed again ${s.cleared} · $${s.costUsd.toFixed(4)}${s.stoppedForBudget ? " · stopped at the day's cap" : ""}`);
    });

  ai.command("renown")
    .description("Ask Claude which of an area's places it recognises by name as worth going to (an estimate, ranking only; nothing is fetched)")
    .requiredOption("--area <slug>", "service area")
    .option("--save <file>", "keep what was asked: read first when it exists (nothing in it is asked again), written at the end")
    .option("--from-file <file>", "replay a capture (--save) and ask nothing")
    .option("--limit <n>", "at most this many places asked about this run", (v) => parseInt(v, 10))
    .option("--clear", "take back the area's renown facts and forget what was asked")
    .option("--dry-run", "ask nothing: how many places and questions a run would take, and the most it could cost")
    .action(async (o: { area: string; save?: string; fromFile?: string; limit?: number; clear?: boolean; dryRun?: boolean }) => {
      if (o.clear) {
        console.log(`renown cleared for ${await clearRenown(getDb(), o.area)} venues of ${o.area}`);
        return;
      }
      if (o.dryRun) {
        const { model, budgetUsd } = aiSettings(process.env);
        const batches = await planRenown(getDb(), o.area, o.limit !== undefined && Number.isFinite(o.limit) ? { limit: o.limit } : {});
        const most = batches.reduce((sum, b) => sum + worstCaseCost(model, b.question.system.length + b.question.user.length, b.question.maxTokens), 0);
        console.log(`  renown     ${batches.reduce((n, b) => n + b.venues.length, 0)} places to ask about in ${batches.length} questions · at most $${most.toFixed(2)} on ${model} (an answer is usually a fraction of the most it may write) · the day's cap is $${budgetUsd.toFixed(2)}`);
        return;
      }
      const s = await rateRenown(getDb(), { areaSlug: o.area, ...(o.save ? { save: o.save } : {}), ...(o.fromFile ? { fromFile: o.fromFile } : {}), ...(o.limit !== undefined && Number.isFinite(o.limit) ? { limit: o.limit } : {}), log: (l) => console.log(l) });
      const said = `${s.destination} destinations, ${s.notable} notable`;
      if (o.fromFile) console.log(`  renown     ${s.replayed} venues replayed (${said}) · ${s.unmatched} entries with no venue here now`);
      else console.log(`  renown     ${s.asked} venues asked about (${said}) · ${s.replayed} replayed · ${s.remaining} still to ask${s.failedBatches ? ` · ${s.failedBatches} batches without a usable answer` : ""} · $${s.costUsd.toFixed(4)}${s.stoppedForBudget ? " · stopped at the day's cap" : ""}`);
    });

  ai.command("spend")
    .description("What Claude has cost in the last 24 hours, against the day's cap")
    .action(async () => {
      const { model, budgetUsd } = aiSettings(process.env);
      console.log(`$${(await spentLastDay(getDb(), new Date())).toFixed(2)} of $${budgetUsd.toFixed(2)} in the last 24 hours · model ${model}`);
    });
}
