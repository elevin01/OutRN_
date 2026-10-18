import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every name resolves to a public address: the requests below are answered by the stub, never sent.
vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] }));

const { guardedFetch, RequestRefused } = await import("./fetch.js");

/** What the stubbed network answers, by URL: a status (and a Location), in order for repeated asks. */
let answers: Record<string, Array<{ status: number; location?: string; body?: string }>> = {};
let sent: string[] = [];

beforeEach(() => {
  sent = [];
  answers = {};
  vi.stubGlobal("fetch", async (url: URL | string) => {
    const u = url.toString();
    sent.push(u);
    const next = answers[u]?.shift() ?? { status: 404 };
    return new Response(next.body ?? (next.status < 300 ? "<p>ok</p>" : ""), { status: next.status, headers: { "content-type": "text/html", ...(next.location ? { location: next.location } : {}) } });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("guardedFetch's gate (PR #57 review)", () => {
  it("is asked before every request: the first, each redirect hop and each retry; a refusal sends nothing", async () => {
    answers["https://site.example.com/start"] = [{ status: 302, location: "/private/hours" }];
    answers["https://site.example.com/private/hours"] = [{ status: 200 }];
    const asked: string[] = [];
    const gate = async (url: URL) => {
      asked.push(url.toString());
      if (url.pathname.startsWith("/private")) throw new RequestRefused(`robots.txt disallows ${url.pathname}`, "robots", url.host);
      return { throttleKey: `t:${url.host}`, minIntervalMs: 0 };
    };
    await expect(guardedFetch("https://site.example.com/start", { sourceId: "test", beforeRequest: gate, retries: 0 })).rejects.toBeInstanceOf(RequestRefused);
    expect(asked).toEqual(["https://site.example.com/start", "https://site.example.com/private/hours"]);
    expect(sent).toEqual(["https://site.example.com/start"]);

    // A move to www. is a hop like any other: asked of the gate, with the new host.
    answers["https://bare.example.com/"] = [{ status: 301, location: "https://www.bare.example.com/" }];
    answers["https://www.bare.example.com/"] = [{ status: 200 }];
    asked.length = 0;
    await guardedFetch("https://bare.example.com/", { sourceId: "test", beforeRequest: gate, retries: 0, sameSiteRedirects: true });
    expect(asked).toEqual(["https://bare.example.com/", "https://www.bare.example.com/"]);

    // A retry is another request: asked again.
    answers["https://busy.example.com/"] = [{ status: 500 }, { status: 200 }];
    asked.length = 0;
    await guardedFetch("https://busy.example.com/", { sourceId: "test", beforeRequest: gate, retries: 1 });
    expect(asked).toEqual(["https://busy.example.com/", "https://busy.example.com/"]);
  });

  it("names the host that answered a 429, after a redirect to another", async () => {
    answers["https://a.example.com/"] = [{ status: 302, location: "https://www.a.example.com/" }];
    answers["https://www.a.example.com/"] = [{ status: 429 }];
    const e = await guardedFetch("https://a.example.com/", { sourceId: "test", retries: 0, sameSiteRedirects: true, minIntervalMs: 0 }).catch((x: unknown) => x);
    expect((e as { status?: number; host?: string }).status).toBe(429);
    expect((e as { host?: string }).host).toBe("www.a.example.com");
  });
});
