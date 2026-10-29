import type { Command } from "commander";
import { getDb } from "@outrn/db";
import { REFRESH_JOBS, runRefresh } from "@outrn/ingest";

export function registerRefresh(program: Command): void {
  program
    .command("refresh")
    .description("Keep events, venues' own sites, calendars and the forecast current: each job on its own cadence, in a loop (or --once)")
    .option("--once", "run each due job once and exit (for a scheduler such as cron)")
    .option("--only <jobs>", "only these jobs, comma-separated (see --list)")
    .option("--list", "list the jobs and their cadence")
    .action(async (o: { once?: boolean; only?: string; list?: boolean }) => {
      if (o.list) {
        for (const j of REFRESH_JOBS) console.log(`${j.id.padEnd(13)} every ${j.everyMinutes >= 60 ? `${j.everyMinutes / 60} h` : `${j.everyMinutes} min`}  ${j.title}${j.needs?.length ? ` (needs ${j.needs.join(", ")})` : ""}`);
        return;
      }
      const only = o.only?.split(",").map((x) => x.trim()).filter(Boolean);
      const unknown = only?.filter((id) => !REFRESH_JOBS.some((j) => j.id === id)) ?? [];
      if (unknown.length) throw new Error(`no such job: ${unknown.join(", ")} (outrn refresh --list)`);
      const jobs = only ? REFRESH_JOBS.filter((j) => only.includes(j.id)) : REFRESH_JOBS;
      const stop = new AbortController();
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => stop.abort());
      const stamp = () => new Date().toISOString().slice(11, 19);
      if (!o.once) console.log(`refresh: ${jobs.map((j) => j.id).join(", ")} (ctrl-c stops it)`);
      const runs = await runRefresh(getDb(), { jobs, once: o.once ?? false, signal: stop.signal, log: (l) => console.log(`${stamp()} ${l}`) });
      if (o.once && runs.some((r) => r.outcome === "failed")) process.exitCode = 1;
    });
}
