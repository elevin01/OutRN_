import { describe, expect, it } from "vitest";
import { normalizeRobotsPath, parseRobots, productToken, robotsAllows, type RobotsPolicy } from "./robots.js";

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

  it("compares paths as RFC 9309 says: an encoded unreserved character is the character, a reserved one stays encoded (PR #57 review)", () => {
    const p = policy(`User-agent: *\nDisallow: /private\nDisallow: /a%2fb\nDisallow: /caf%C3%A9\n`);
    expect(robotsAllows(p, "/private/hours")).toBe(false);
    expect(robotsAllows(p, "/%70rivate/hours")).toBe(false);
    expect(robotsAllows(p, "/%70RIVATE/hours")).toBe(true); // case matters in paths
    // %2F is not "/": the rule for "/a%2fb" (either case) blocks only the encoded form.
    expect(robotsAllows(p, "/a%2Fb")).toBe(false);
    expect(robotsAllows(p, "/a/b")).toBe(true);
    // Characters outside ASCII are compared as their UTF-8 encoding.
    expect(robotsAllows(p, "/café")).toBe(false);
    expect(normalizeRobotsPath("/%7euser/%41%2f%3F")).toBe("/~user/A%2F%3F");
  });

  it("reads a $ rule without * as the whole path: \"Allow: /$\" is the home page, not every path ending in /", () => {
    const home = policy(`User-agent: *\nAllow: /$\nDisallow: /\n`);
    expect([robotsAllows(home, "/"), robotsAllows(home, "/hours/"), robotsAllows(home, "/private/")]).toEqual([true, false, false]);
    const exact = policy(`User-agent: *\nDisallow: /x$\n`);
    expect([robotsAllows(exact, "/x"), robotsAllows(exact, "/x/y/x"), robotsAllows(exact, "/xy")]).toEqual([false, true, true]);
    expect(robotsAllows(policy(`User-agent: *\nDisallow: /*/menu$\n`), "/a/menu")).toBe(false);
    expect(robotsAllows(policy(`User-agent: *\nDisallow: /a*b$\n`), "/ab")).toBe(false);
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
