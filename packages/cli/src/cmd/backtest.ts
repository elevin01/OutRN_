import { writeFileSync } from "node:fs";
import type { Command } from "commander";
import { fromLocal, type LatLon } from "@outrn/core";
import { getArea, getDb } from "@outrn/db";
import { loadCandidates, loadPolicies, recommend, type RequestContext } from "@outrn/engine";

/**
 * Coverage backtest: the gate that matters most. For a grid of sample points across an area and a
 * matrix of days × hours × windows × budgets, run the engine and count the funnel. Output is the
 * heatmap that picks launch windows, plus the exclusion reasons that dominate each empty cell.
 */

interface Cell {
  day: string;
  hour: number;
  window: number;
  budget: string;
  points: number;
  three: number; // points with ≥3 shortlisted
  ready3: number; // points with ≥3 READY
  avgEligible: number;
  topExclusions: string[];
}

export function registerBacktest(program: Command): void {
  program
    .command("backtest")
    .description("Coverage matrix for an area: how often does the engine produce three options?")
    .requiredOption("--area <slug>")
    .option("--week-of <date>", "Monday of the week to simulate (YYYY-MM-DD)", "2026-10-05")
    .option("--grid <n>", "sample points per side", (v) => parseInt(v, 10), 3)
    .option("--hours <list>", "local hours to test", "11,14,17,19,21")
    .option("--windows <list>", "window lengths in minutes", "60,180")
    .option("--budgets <list>", "budgets: any, free, or a number", "any,free,25")
    .option("--days <list>", "weekdays 0-6 (Sun=0)", "2,5,6")
    .option("--out <path>", "write JSON results here")
    .action(async (o: { area: string; weekOf: string; grid: number; hours: string; windows: string; budgets: string; days: string; out?: string }) => {
      const db = getDb();
      const area = await getArea(db, o.area);
      const policies = await loadPolicies(db);
      const radius = area.radius_m ?? 1500;
      const pts: LatLon[] = [];
      const n = Math.max(1, o.grid);
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++) {
          const fx = n === 1 ? 0 : (i / (n - 1) - 0.5) * 1.2;
          const fy = n === 1 ? 0 : (j / (n - 1) - 0.5) * 1.2;
          pts.push({ lat: area.lat + (fy * radius) / 111_320, lon: area.lon + (fx * radius) / (111_320 * Math.cos((area.lat * Math.PI) / 180)) });
        }
      const monday = o.weekOf;
      const days = o.days.split(",").map(Number);
      const hours = o.hours.split(",").map(Number);
      const windows = o.windows.split(",").map(Number);
      const budgets = o.budgets.split(",");
      const cells: Cell[] = [];
      const t0 = Date.now();
      let runs = 0;
      for (const wd of days) {
        const [y, m, d] = monday.split("-").map(Number) as [number, number, number];
        const date = new Date(Date.UTC(y, m - 1, d + ((wd + 6) % 7)));
        const dateStr = date.toISOString().slice(0, 10);
        const dayName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][wd]!;
        for (const hour of hours)
          for (const window of windows)
            for (const budget of budgets) {
              const now = fromLocal(dateStr, hour * 60, area.timezone);
              const end = new Date(now.getTime() + window * 60_000);
              let three = 0;
              let ready3 = 0;
              let eligibleSum = 0;
              const exclusions = new Map<string, number>();
              for (const p of pts) {
                const ctx: RequestContext = { origin: p, now, windowMinutes: window, mode: area.travel_mode, timezone: area.timezone };
                if (budget === "free") ctx.budget = "free";
                else if (budget !== "any") ctx.budget = Number(budget);
                const cands = await loadCandidates(db, p, area.travel_mode, now, end);
                const s = recommend(cands, ctx, policies);
                runs++;
                if (s.items.length >= 3) three++;
                if (s.items.filter((e) => e.class === "ready").length >= 3) ready3++;
                eligibleSum += s.all.filter((e) => e.class !== "ineligible").length;
                for (const e of s.all) if (e.excludedBy) exclusions.set(e.excludedBy, (exclusions.get(e.excludedBy) ?? 0) + 1);
              }
              const top = [...exclusions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k} ${v}`);
              cells.push({ day: dayName, hour, window, budget, points: pts.length, three, ready3, avgEligible: +(eligibleSum / pts.length).toFixed(1), topExclusions: top });
            }
      }
      const ms = Date.now() - t0;
      // Heatmap: rows = day × hour, cols = window × budget, value = % of points with three options
      console.log(`${area.name} · ${pts.length} points · ${runs} engine runs · ${ms} ms (${Math.round(ms / runs)} ms/run)\n`);
      const cols = windows.flatMap((w) => budgets.map((b) => `${w}m/${b}`));
      console.log(`${"".padEnd(9)}${cols.map((c) => c.padStart(11)).join("")}`);
      for (const wd of days)
        for (const hour of hours) {
          const dayName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][wd]!;
          const row = cols.map((c) => {
            const [w, b] = c.split("/") as [string, string];
            const cell = cells.find((x) => x.day === dayName && x.hour === hour && x.window === parseInt(w, 10) && x.budget === b)!;
            const pct = Math.round((100 * cell.three) / cell.points);
            const rp = Math.round((100 * cell.ready3) / cell.points);
            return `${String(pct).padStart(3)}%/${String(rp).padStart(3)}%`.padStart(11);
          });
          console.log(`${dayName} ${String(hour).padStart(2)}:00 ${row.join("")}`);
        }
      console.log("\ncell = % of sample points with three options / % with three READY options");
      const worst = [...cells].sort((a, b) => a.three / a.points - b.three / b.points).slice(0, 5);
      console.log("\nweakest cells and what excluded candidates there:");
      for (const c of worst) console.log(`  ${c.day} ${c.hour}:00 ${c.window}m ${c.budget.padEnd(5)} three ${c.three}/${c.points} · avg eligible ${c.avgEligible} · ${c.topExclusions.join(", ")}`);
      const overall = cells.reduce((a, c) => a + c.three, 0) / cells.reduce((a, c) => a + c.points, 0);
      console.log(`\noverall: three options in ${Math.round(overall * 100)}% of ${cells.length * pts.length} sampled contexts (gate: 90% of ADVERTISED windows)`);
      if (o.out) {
        writeFileSync(o.out, JSON.stringify({ area: area.slug, weekOf: monday, cells }, null, 1));
        console.log(`wrote ${o.out}`);
      }
    });
}
