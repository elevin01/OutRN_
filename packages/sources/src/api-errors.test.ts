import { beforeEach, describe, expect, it, vi } from "vitest";
import { FetchBlocked, FetchFailed } from "./fetch.js";

/** A keyed API's failures never carry its key: whatever the answer's body, a parser's snippet, or the error underneath says. */

const fetchMock = vi.hoisted(() => ({ next: (_url: string): Promise<{ text: string }> => Promise.reject(new Error("unset")) }));
vi.mock("./fetch.js", async (orig) => ({ ...(await orig<typeof import("./fetch.js")>()), guardedFetch: (url: string) => fetchMock.next(url) }));

const { fetchTicketedEvents } = await import("./ticketing.js");
const { fetchFilmsNow } = await import("./tmdb.js");
const { keySafeError } = await import("./api-errors.js");

const KEYS = { plain: "synthetic-review-secret-69", bearer: "eyJhbGciOiJIUzI1NiJ9.synthetic-review-secret-69.sig" };
const ENCODED = encodeURIComponent(KEYS.plain);
const q = (key: string) => ({ center: { lat: 40.7185, lon: -73.988 }, radiusM: 3000, from: new Date("2026-10-29T16:00:00Z"), until: new Date("2026-11-12T16:00:00Z"), key });

/** Every way a failure could echo the request: the body says the key, raw and URL-encoded; the URL carries it. */
const failures = (key: string): [string, (url: string) => Promise<{ text: string }>][] => [
  ["an error status whose body echoes the key", async (url) => Promise.reject(new FetchFailed(`400 from api.example: Invalid API credential: ${key} ${encodeURIComponent(key)} ${url}`, 400))],
  ["a network failure naming the URL", async (url) => Promise.reject(new FetchFailed(`could not resolve ${url}: ${key}`))],
  ["a refusal naming the URL", async (url) => Promise.reject(new FetchBlocked(`more than 5 redirects from ${url}`))],
  ["an answer that isn't JSON", async () => ({ text: `Invalid API credential: ${key}` })],
  ["an answer in another shape", async () => ({ text: JSON.stringify({ error: key }) })],
  ["anything else", async (url) => Promise.reject(new TypeError(`fetch failed for ${url} (${key})`))],
];

const leaks = (message: string, key: string) => message.includes(key) || message.includes(encodeURIComponent(key)) || message.includes(ENCODED);

describe("keyed APIs' failures", () => {
  beforeEach(() => {
    fetchMock.next = () => Promise.reject(new Error("unset"));
  });

  for (const source of ["ticketmaster", "seatgeek"] as const) {
    for (const [what, fail] of failures(KEYS.plain)) {
      it(`${source}: ${what} comes out as its status alone`, async () => {
        fetchMock.next = fail;
        const err = (await fetchTicketedEvents(source, q(KEYS.plain)).catch((e: unknown) => e)) as Error;
        expect(err).toBeInstanceOf(Error);
        expect(err.message.startsWith(`${source}: the API`)).toBe(true);
        expect(leaks(err.message, KEYS.plain)).toBe(false);
        expect((err as { cause?: unknown }).cause).toBeUndefined();
      });
    }
  }

  for (const [mode, key] of Object.entries(KEYS)) {
    for (const [what, fail] of failures(key)) {
      it(`tmdb (${mode} key): ${what} comes out as its status alone`, async () => {
        fetchMock.next = fail;
        const err = (await fetchFilmsNow(key).catch((e: unknown) => e)) as Error;
        expect(err.message.startsWith("tmdb: the API")).toBe(true);
        expect(leaks(err.message, key)).toBe(false);
      });
    }
  }

  it("says what kind of failure it was", () => {
    expect(keySafeError("x", new FetchFailed("429 from h: slow down", 429)).message).toBe("x: the API answered 429");
    expect(keySafeError("x", new FetchFailed("timeout")).message).toBe("x: the API could not be reached");
    expect(keySafeError("x", new SyntaxError("Unexpected token")).message).toBe("x: the API's answer was not JSON");
  });
});
