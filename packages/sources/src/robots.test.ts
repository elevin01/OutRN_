import { describe, expect, it } from "vitest";
import { parseRobots, productToken, robotsAllows, type RobotsPolicy } from "./robots.js";

const policy = (text: string, token = "outrn-dev"): RobotsPolicy => ({ status: "ok", ...parseRobots(text, token) });

describe("robots.txt (RFC 9309)", () => {
  it("takes our product token from the user agent", () => {
    expect(productToken("OutRN-dev/0.1 (https://github.com/elevin01/OutRN_)")).toBe("outrn-dev");
  });

  it("follows the group for our agent when there is one, else the * group", () => {
    const text = `User-agent: *\nDisallow: /\n\nUser-agent: OutRN-dev\nAllow: /hours\nDisallow: /admin\n`;
    expect(robotsAllows(policy(text), "/hours")).toBe(true);
    expect(robotsAllows(policy(text), "/menu")).toBe(true);
    expect(robotsAllows(policy(text), "/admin/x")).toBe(false);
    // Another agent's group says nothing to us; the * group does.
    expect(robotsAllows(policy(text, "someone-else"), "/hours")).toBe(false);
    // Several agents for one group, and groups for our agent merged.
    const merged = policy(`User-agent: googlebot\nUser-agent: outrn\nDisallow: /a\n\nUser-agent: OUTRN-DEV\nDisallow: /b\n`);
    expect([robotsAllows(merged, "/a"), robotsAllows(merged, "/b"), robotsAllows(merged, "/c")]).toEqual([false, false, true]);
  });

  it("lets the longest matching rule win, allow on a tie, with * and $", () => {
    const p = policy(`User-agent: *\nDisallow: /private\nAllow: /private/hours\nDisallow: /*.pdf$\nDisallow: /search*q=\nAllow: /same\nDisallow: /same\n`);
    expect(robotsAllows(p, "/private/menu")).toBe(false);
    expect(robotsAllows(p, "/private/hours.html")).toBe(true);
    expect(robotsAllows(p, "/menu.pdf")).toBe(false);
    expect(robotsAllows(p, "/menu.pdf?v=2")).toBe(true);
    expect(robotsAllows(p, "/search?x=1&q=pizza")).toBe(false);
    expect(robotsAllows(p, "/same")).toBe(true);
    expect(robotsAllows(p, "/robots.txt")).toBe(true);
  });

  it("reads an empty Disallow as no rule, comments as nothing, and the crawl delay (capped)", () => {
    expect(robotsAllows(policy(`User-agent: * # everyone\nDisallow:\n`), "/anything")).toBe(true);
    expect(policy(`User-agent: *\nCrawl-delay: 10\n`).crawlDelayS).toBe(10);
    expect(policy(`User-agent: *\nCrawl-delay: 99999\n`).crawlDelayS).toBe(120);
  });

  it("allows everything when there is no robots.txt, and nothing when it can't be read", () => {
    expect(robotsAllows({ status: "none", rules: [], crawlDelayS: null }, "/x")).toBe(true);
    expect(robotsAllows({ status: "unreachable", rules: [], crawlDelayS: null }, "/x")).toBe(false);
  });
});
