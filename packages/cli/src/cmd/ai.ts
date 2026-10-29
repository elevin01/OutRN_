import type { Command } from "commander";
import { getDb } from "@outrn/db";
import { aiSettings, readEventsWithClaude, recheckEventsWithClaude, spentLastDay } from "@outrn/ingest";

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
      console.log(`events ${s.events} · checked ${s.checked} · cancelled ${s.marked.cancelled} · sold out ${s.marked.sold_out} · $${s.costUsd.toFixed(4)}${s.stoppedForBudget ? " · stopped at the day's cap" : ""}`);
    });

  ai.command("spend")
    .description("What Claude has cost in the last 24 hours, against the day's cap")
    .action(async () => {
      const { model, budgetUsd } = aiSettings(process.env);
      console.log(`$${(await spentLastDay(getDb(), new Date())).toFixed(2)} of $${budgetUsd.toFixed(2)} in the last 24 hours · model ${model}`);
    });
}
