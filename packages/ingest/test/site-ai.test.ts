import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { testDatabaseAvailable, reset } from "@outrn/db";
import type { Asker, JsonQuestion } from "../src/claude.js";
import { costOf, worstCaseCost } from "../src/claude.js";
import type { SiteFetcher } from "../src/firstparty-job.js";
import { registerSite } from "../src/firstparty-job.js";
import { ingestOsmArea } from "../src/pipeline.js";
import { checkReadEvent, norm, quoteHasDay, quoteHasTime, readEventsWithClaude, recheckEventsWithClaude, recheckVerdict, spentLastDay, statedPrice } from "../src/site-ai.js";

/** Claude reading venues' pages: every event checked against the page; spending capped (outrn_test, reset per file). */

const TZ = "America/New_York";
const NOW = new Date("2026-10-29T16:00:00Z"); // Thursday noon in New York

describe("what a quote must say", () => {
  it("the time, however the page writes it", () => {
    expect(quoteHasTime("Fri Oct 30 · 7:30 PM", "19:30")).toBe(true);
    expect(quoteHasTime("Fri 7pm", "19:00")).toBe(true);
    expect(quoteHasTime("Friday at 7 p.m.", "19:00")).toBe(true);
    expect(quoteHasTime("30.10 · 19:30", "19:30")).toBe(true);
    expect(quoteHasTime("Sat 12 noon matinee", "12:00")).toBe(true);
    expect(quoteHasTime("Fri 8pm", "19:00")).toBe(false);
    expect(quoteHasTime("Fri 7am", "19:00")).toBe(false);
    // 17:30 is not 7:30, and a morning is not an evening.
    expect(quoteHasTime("Fri 17:30", "19:30")).toBe(false);
    expect(quoteHasTime("Friday Oct 30 at 7:30 AM", "19:30")).toBe(false);
    expect(quoteHasTime("Friday Oct 30 at 7:30 PM", "19:30")).toBe(true);
    expect(quoteHasTime("Friday Oct 30 at 7:30", "19:30")).toBe(true);
    expect(quoteHasTime("Sunday 10:30 a.m. brunch screening", "10:30")).toBe(true);
    expect(quoteHasTime("Sunday 10:30 p.m.", "10:30")).toBe(false);
  });

  it("the day: its date's number, its weekday, or tonight/tomorrow when it is", () => {
    expect(quoteHasDay("Fri Oct 30 7:30pm", "2026-10-30", "2026-10-29")).toBe(true);
    expect(quoteHasDay("10/30 7:30pm", "2026-10-30", "2026-10-29")).toBe(true);
    expect(quoteHasDay("Saturday 8pm", "2026-10-31", "2026-10-29")).toBe(true);
    expect(quoteHasDay("Tonight 8pm", "2026-10-29", "2026-10-29")).toBe(true);
    expect(quoteHasDay("Tonight 8pm", "2026-10-30", "2026-10-29")).toBe(false);
    expect(quoteHasDay("Tomorrow 8pm", "2026-10-30", "2026-10-29")).toBe(true);
    expect(quoteHasDay("Oct 31 8pm", "2026-10-30", "2026-10-29")).toBe(false);
    // A time's minutes are not a day.
    expect(quoteHasDay("Doors 7:30pm", "2026-10-30", "2026-10-29")).toBe(false);
    // A date written out decides, whatever weekday the quote also names.
    expect(quoteHasDay("Friday Oct 30 at 7pm", "2026-11-06", "2026-10-29")).toBe(false);
    expect(quoteHasDay("Friday Oct 30 at 7pm", "2026-10-30", "2026-10-29")).toBe(true);
    expect(quoteHasDay("Friday 30 October, 7pm", "2026-10-30", "2026-10-29")).toBe(true);
    expect(quoteHasDay("11/6 7pm", "2026-10-30", "2026-10-29")).toBe(false);
    // A weekday that is not this day's is against it.
    expect(quoteHasDay("Saturday 8pm", "2026-10-30", "2026-10-29")).toBe(false);
    expect(quoteHasDay("Fri & Sat 8pm", "2026-10-31", "2026-10-29")).toBe(true);
    expect(quoteHasDay("on the 30th at 8pm", "2026-10-30", "2026-10-29")).toBe(true);
  });

  it("a price only as the page writes it", () => {
    const page = norm("Anora · $15 · Members free · Double feature $10–$25");
    expect(statedPrice("$15", page)).toEqual({ min: 15, max: 15, currency: "USD" });
    expect(statedPrice("$10–$25", page)).toEqual({ min: 10, max: 25, currency: "USD" });
    expect(statedPrice("$12", page)).toBeUndefined();
    expect(statedPrice("Members free", page)).toBeUndefined();
  });
});

const PAGE = `Now Playing
Anora
Thu Oct 29 · 7:30 PM · $15
Fri Oct 30 · 9:45 PM · $15 · SOLD OUT
The Brutalist (70mm)
Saturday Oct 31 at 2pm
Members' screening`;

describe("an event Claude read, checked against the page", () => {
  const ctx = { page: norm(PAGE), venueId: "v1", url: "https://www.broomecinema.com/now-playing", timeZone: TZ, now: NOW };
  const read = (over: Record<string, unknown> = {}) => ({ title: "Anora", date: "2026-10-29", time: "19:30", end_time: "", price: "$15", sold_out: false, quote: "Thu Oct 29 · 7:30 PM", ...over });

  it("is kept with its start in UTC, the page's link, its stated price, and the quote as evidence", () => {
    const e = checkReadEvent(read(), ctx);
    expect(e).toMatchObject({ title: "Anora", start: "2026-10-29T23:30:00.000Z", end: null, url: ctx.url, price: { min: 15, max: 15, currency: "USD" }, place: { venue: "v1" } });
    expect((e as { evidence: string }).evidence).toBe('read by Claude from https://www.broomecinema.com/now-playing: "Thu Oct 29 · 7:30 PM"');
    expect((e as { id: string }).id).toMatch(/^ai\/[0-9a-f]{24}$/);
    // The same event read again has the same id.
    expect((checkReadEvent(read(), ctx) as { id: string }).id).toBe((e as { id: string }).id);
  });

  it("sold out only on the page's words", () => {
    expect(checkReadEvent(read({ date: "2026-10-30", time: "21:45", sold_out: true, quote: "Fri Oct 30 · 9:45 PM · $15 · SOLD OUT" }), ctx)).toMatchObject({ status: "sold_out" });
    expect(checkReadEvent(read({ sold_out: true }), ctx)).not.toHaveProperty("status");
  });

  it("is left out when the page doesn't say it: a title or quote not on it, a time or day the quote lacks, a date out of range", () => {
    expect(checkReadEvent(read({ title: "Wicked" }), ctx)).toEqual({ skip: "title_not_on_page" });
    expect(checkReadEvent(read({ quote: "Thu Oct 29 · 7:00 PM" }), ctx)).toEqual({ skip: "quote_not_on_page" });
    expect(checkReadEvent(read({ time: "20:30" }), ctx)).toEqual({ skip: "no_time" });
    expect(checkReadEvent(read({ date: "2026-10-28" }), ctx)).toEqual({ skip: "no_day" });
    // What the quote says against it: the morning for an evening show, a date a week off.
    const page2 = { ...ctx, page: norm("Anora · Friday Oct 30 at 7:30 AM · Friday Oct 30 at 7pm") };
    expect(checkReadEvent(read({ date: "2026-10-30", quote: "Friday Oct 30 at 7:30 AM" }), page2)).toEqual({ skip: "no_time" });
    expect(checkReadEvent(read({ date: "2026-11-06", time: "19:00", quote: "Friday Oct 30 at 7pm" }), page2)).toEqual({ skip: "no_day" });
    expect(checkReadEvent(read({ date: "2026-10-30", time: "19:00", quote: "Friday Oct 30 at 7pm" }), page2)).toMatchObject({ start: "2026-10-30T23:00:00.000Z" });
    expect(checkReadEvent(read({ title: "The Brutalist (70mm)", date: "2026-11-21", time: "14:00", quote: "Saturday Oct 31 at 2pm" }), ctx)).toEqual({ skip: "no_day" });
    // More than two weeks ahead of when it is read.
    expect(checkReadEvent(read({ title: "The Brutalist (70mm)", date: "2026-10-31", time: "14:00", quote: "Saturday Oct 31 at 2pm" }), { ...ctx, now: new Date("2026-10-01T16:00:00Z") })).toEqual({ skip: "out_of_range" });
    expect(checkReadEvent(read({ date: "Thursday" }), ctx)).toEqual({ skip: "unreadable" });
    expect(checkReadEvent(null, ctx)).toEqual({ skip: "unreadable" });
  });
});

describe("a re-check's verdict", () => {
  const page = norm("Anora — Fri Oct 30 9:45 PM — SOLD OUT. Wicked — Sat Oct 31 2pm — cancelled due to a projector fault. Conclave Sat 4pm is not cancelled. Anora Sat 7pm is not sold out: tickets available.");
  const anora = { title: "Anora", time: "21:45" };
  it("cancelled or sold out only in the page's own words, for this event at its time", () => {
    expect(recheckVerdict({ status: "sold_out", quote: "Anora — Fri Oct 30 9:45 PM — SOLD OUT" }, page, anora)).toBe("sold_out");
    expect(recheckVerdict({ status: "cancelled", quote: "Wicked — Sat Oct 31 2pm — cancelled due to a projector fault" }, page, { title: "Wicked", time: "14:00" })).toBe("cancelled");
    // Not this event: another show's cancellation on the same page, or this one at another time.
    expect(recheckVerdict({ status: "cancelled", quote: "Wicked — Sat Oct 31 2pm — cancelled due to a projector fault" }, page, anora)).toBeNull();
    expect(recheckVerdict({ status: "sold_out", quote: "Anora — Fri Oct 30 9:45 PM — SOLD OUT" }, page, { title: "Anora", time: "19:00" })).toBeNull();
    // Words that say it is not.
    expect(recheckVerdict({ status: "cancelled", quote: "Conclave Sat 4pm is not cancelled" }, page, { title: "Conclave", time: "16:00" })).toBeNull();
    expect(recheckVerdict({ status: "sold_out", quote: "Anora Sat 7pm is not sold out" }, page, { title: "Anora", time: "19:00" })).toBeNull();
    // Not on the page, or a status the words don't carry.
    expect(recheckVerdict({ status: "sold_out", quote: "Anora 9:45 PM SOLD OUT tonight" }, page, anora)).toBeNull();
    expect(recheckVerdict({ status: "cancelled", quote: "Anora — Fri Oct 30 9:45 PM" }, page, anora)).toBeNull();
  });

  it("listed again, only for this event at its time, and never where the words say off or full", () => {
    expect(recheckVerdict({ status: "listed", quote: "Anora Sat 7pm is not sold out: tickets available" }, page, { title: "Anora", time: "19:00" })).toBe("listed");
    expect(recheckVerdict({ status: "listed", quote: "Anora — Fri Oct 30 9:45 PM — SOLD OUT" }, page, anora)).toBeNull();
    expect(recheckVerdict({ status: "listed", quote: "Anora Sat 7pm is not sold out" }, page, anora)).toBeNull();
  });
});

describe("what Claude costs", () => {
  it("from the response's token usage at its model's rates; an unknown model at the dearest", () => {
    expect(costOf("claude-opus-5-5", { input_tokens: 10_000, output_tokens: 1_000 })).toBeCloseTo(0.06, 6);
    expect(costOf("claude-haiku-5-5", { input_tokens: 10_000, output_tokens: 1_000 })).toBeCloseTo(0.0015, 6);
    expect(costOf("claude-opus-5-5", { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 10_000 })).toBeCloseTo(0.004, 6);
    expect(costOf("some-new-model", { input_tokens: 1_000_000, output_tokens: 0 })).toBe(10);
    expect(worstCaseCost("claude-opus-5-5", 30_000, 6_000)).toBeCloseTo(0.16, 6);
  });
});

const BASE = process.env["DATABASE_URL"] ?? "postgres://outrn@127.0.0.1:54329/outrn";
const TEST_URL = BASE.replace(/\/[^/]+$/, "/outrn_test");
const FIXTURE = resolve(__dirname, "../../../fixtures/osm/les-synthetic.json");
const available = await testDatabaseAvailable(BASE);
let db: pg.Pool;

beforeAll(async () => {
  if (!available) return;
  const admin = new pg.Pool({ connectionString: BASE });
  try {
    const exists = await admin.query("select 1 from pg_database where datname = 'outrn_test'");
    if (!exists.rowCount) await admin.query("create database outrn_test");
  } finally {
    await admin.end();
  }
  db = new pg.Pool({ connectionString: TEST_URL });
  await db.query("create extension if not exists postgis; create extension if not exists pgcrypto;");
  await reset(db);
  await ingestOsmArea(db, { areaSlug: "les", fromFile: FIXTURE });
});

afterAll(async () => {
  if (db) await db.end();
});

/** A site whose pages are given, through the real gate (robots.txt allows everything). */
const fetcher = (pages: Record<string, string>): SiteFetcher => ({
  robots: async () => ({ status: "none", rules: [], crawlDelayS: null }),
  page: async () => {
    throw new Error("not used");
  },
  text: async (url, o) => {
    await o.gate(new URL(url));
    const html = pages[url];
    if (html === undefined) throw new Error(`404 from ${new URL(url).host}`);
    return html;
  },
});
const HOME = `<html><body><h1>Broome Cinema</h1><a href="/now-playing">Now playing</a></body></html>`;
const html = (text: string) => `<html><body>${text.split("\n").map((l) => `<p>${l}</p>`).join("")}<script>var x = "ignore";</script></body></html>`;
const ENV = { ANTHROPIC_API_KEY: "test-key", OUTRN_AI_DAILY_BUDGET_USD: "1" };

describe.skipIf(!available)("reading pages with Claude", () => {
  let venueId = "";
  const asked: JsonQuestion[] = [];
  const asker =
    (answer: unknown, costUsd = 0.012): Asker =>
    async (q) => {
      asked.push(q);
      return { data: answer, stopReason: "end_turn", model: "claude-opus-5-5", costUsd };
    };

  it("reads an event venue's own events page, writes what the page says, and leaves out what it doesn't", async () => {
    venueId = (await db.query<{ id: string }>(`select id from venues where canonical_name = 'Broome Cinema'`)).rows[0]!.id;
    await registerSite(db, venueId, "https://www.broomecinema.com/", "auto: its own website lists its events", true);
    await db.query(`update firstparty_sites set last_status = 'no_jsonld', last_fetched_at = $1 where venue_id = $2`, [NOW, venueId]);
    const s = await readEventsWithClaude(db, {
      now: NOW,
      env: ENV,
      fetcher: fetcher({ "https://www.broomecinema.com/": HOME, "https://www.broomecinema.com/now-playing": html(PAGE) }),
      ask: asker({
        events: [
          { title: "Anora", date: "2026-10-29", time: "19:30", end_time: "", price: "$15", sold_out: false, quote: "Thu Oct 29 · 7:30 PM · $15" },
          { title: "Wicked", date: "2026-10-30", time: "20:00", end_time: "", price: "", sold_out: false, quote: "Fri Oct 30 · 8:00 PM" },
        ],
      }),
    });
    expect([s.pages, s.read, s.events]).toEqual([1, 1, 1]);
    expect(s.skipped).toEqual({ title_not_on_page: 1 });
    // The page's visible text went to Claude, as data; not the scripts.
    expect(asked[0]!.user).toContain("<page>\nNow Playing\nAnora");
    expect(asked[0]!.user).not.toContain("ignore");
    const occ = (await db.query<{ title: string; venue_id: string; start_at: Date }>(`select title, venue_id, start_at from occurrences where recurrence_key like 'site_ai:%'`)).rows;
    expect(occ).toEqual([{ title: "Anora", venue_id: venueId, start_at: new Date("2026-10-29T23:30:00Z") }]);
    // What it cost is in the run log, in whole cents, up.
    expect(await spentLastDay(db, NOW)).toBeCloseTo(0.02, 6);
  });

  it("reads a page at most once in 20 hours, and none that a venue's other sources already list events for", async () => {
    const s = await readEventsWithClaude(db, { now: new Date(NOW.getTime() + 3_600_000), env: ENV, fetcher: fetcher({}), ask: asker({ events: [] }) });
    expect(s.pages).toBe(0);
  });

  it("sends nothing that could take the day past its cap", async () => {
    // A host's four requests a day are the gate's to keep: each case here starts a new day for it.
    await db.query(`delete from firstparty_hosts`);
    await db.query(`delete from ai_page_reads`);
    await db.query(`delete from occurrences where recurrence_key like 'site_ai:%'`);
    const before = asked.length;
    const s = await readEventsWithClaude(db, {
      now: NOW,
      env: { ...ENV, OUTRN_AI_DAILY_BUDGET_USD: "0.05" },
      fetcher: fetcher({ "https://www.broomecinema.com/": HOME, "https://www.broomecinema.com/now-playing": html(PAGE) }),
      ask: asker({ events: [] }),
    });
    expect(s.stoppedForBudget).toBe(true);
    expect(asked.length).toBe(before);
  });

  it("re-checks an event about to start and marks it sold out on its page's words", async () => {
    await db.query(`delete from firstparty_hosts`);
    await readEventsWithClaude(db, {
      now: NOW,
      env: ENV,
      fetcher: fetcher({ "https://www.broomecinema.com/": HOME, "https://www.broomecinema.com/now-playing": html(PAGE) }),
      ask: asker({ events: [{ title: "Anora", date: "2026-10-30", time: "21:45", end_time: "", price: "", sold_out: false, quote: "Fri Oct 30 · 9:45 PM · $15" }] }),
    });
    await db.query(`delete from firstparty_hosts`);
    const s = await recheckEventsWithClaude(db, {
      now: new Date(NOW.getTime() + 2 * 3_600_000),
      env: ENV,
      fetcher: fetcher({ "https://www.broomecinema.com/now-playing": html(PAGE) }),
      ask: asker({ status: "sold_out", quote: "Anora Thu Oct 29 · 7:30 PM · $15 Fri Oct 30 · 9:45 PM · $15 · SOLD OUT" }, 0.002),
    });
    expect([s.events, s.checked, s.marked.sold_out]).toEqual([1, 1, 1]);
    const status = async () => (await db.query<{ value: unknown; source_ids: string[] }>(`select f.value, f.source_ids from current_facts f join occurrences o on o.id = f.subject_id where f.subject_kind = 'occurrence' and f.attribute = 'admission_status' and o.recurrence_key like 'site_ai:%'`)).rows;
    expect(await status()).toEqual([{ value: { status: "sold_out" }, source_ids: ["site_ai"] }]);
    // Checked once: not again within 8 hours.
    const again = await recheckEventsWithClaude(db, { now: new Date(NOW.getTime() + 3 * 3_600_000), env: ENV, fetcher: fetcher({}), ask: asker({ status: "listed", quote: "" }) });
    expect(again.events).toBe(0);
    // Nine hours on, tickets are back: the page lists it with no word of being full, and our mark goes.
    const reopened = `Now Playing\nAnora\nFri Oct 30 · 9:45 PM · $15 · Tickets available`;
    await db.query(`delete from firstparty_hosts`);
    const back = await recheckEventsWithClaude(db, { now: new Date(NOW.getTime() + 11 * 3_600_000), env: ENV, fetcher: fetcher({ "https://www.broomecinema.com/now-playing": html(reopened) }), ask: asker({ status: "listed", quote: "Anora Fri Oct 30 · 9:45 PM · $15 · Tickets available" }, 0.002) });
    expect(back.cleared).toBe(1);
    expect(await status()).toEqual([]);
    // And called off after that: cancelled, the one mark of ours.
    const off = `Now Playing\nAnora\nFri Oct 30 · 9:45 PM · CANCELLED`;
    await db.query(`delete from firstparty_hosts`);
    await db.query(`delete from ai_rechecks`);
    const cancelled = await recheckEventsWithClaude(db, { now: new Date(NOW.getTime() + 12 * 3_600_000), env: ENV, fetcher: fetcher({ "https://www.broomecinema.com/now-playing": html(off) }), ask: asker({ status: "cancelled", quote: "Anora Fri Oct 30 · 9:45 PM · CANCELLED" }, 0.002) });
    expect(cancelled.marked.cancelled).toBe(1);
    expect(await status()).toEqual([{ value: { status: "cancelled" }, source_ids: ["site_ai"] }]);
  });

  it("refuses without a key, and while the source is switched off", async () => {
    await expect(readEventsWithClaude(db, { now: NOW, env: {} })).rejects.toThrow(/set ANTHROPIC_API_KEY/);
    await db.query(`update source_policies set enabled = false where id = 'site_ai'`);
    try {
      await expect(readEventsWithClaude(db, { now: NOW, env: ENV, ask: asker({ events: [] }) })).rejects.toThrow(/site_ai: disabled/);
    } finally {
      await db.query(`update source_policies set enabled = true where id = 'site_ai'`);
    }
  });
});
