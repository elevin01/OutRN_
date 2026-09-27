import { describe, expect, it } from "vitest";
import { basicPassword, opsAccess, sameSecret } from "./ops-auth";

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
const prod = { token: "s3cret", nodeEnv: "production" };

describe("ops access in the web layer", () => {
  it("challenges an anonymous visitor, a wrong password and a malformed header", () => {
    for (const header of [null, undefined, "", basic("ops", "wrong"), basic("ops", "s3cret "), "Bearer s3cret", "Basic !!!", `Basic ${Buffer.from("no-colon").toString("base64")}`]) {
      expect(opsAccess(header, prod), String(header)).toEqual({ kind: "challenge" });
    }
  });

  it("lets the operator in and forwards exactly the credential they presented", () => {
    expect(opsAccess(basic("anyone", "s3cret"), prod)).toEqual({ kind: "allow", bearer: "s3cret" });
    const withColon = { ...prod, token: "a:b:c" };
    expect(opsAccess(basic("ops", "a:b:c"), withColon)).toEqual({ kind: "allow", bearer: "a:b:c" });
  });

  it("serves no ops pages from a production build without a token", () => {
    expect(opsAccess(basic("ops", "anything"), { token: undefined, nodeEnv: "production" })).toEqual({ kind: "disabled" });
    expect(opsAccess(null, { token: "", nodeEnv: "production" })).toEqual({ kind: "disabled" });
    expect(opsAccess(null, { token: undefined, nodeEnv: undefined })).toEqual({ kind: "disabled" });
  });

  it("is open while developing without a token, and attaches no credential", () => {
    expect(opsAccess(null, { token: undefined, nodeEnv: "development" })).toEqual({ kind: "allow", bearer: null });
    // A configured token is enforced in development too.
    expect(opsAccess(null, { token: "s3cret", nodeEnv: "development" })).toEqual({ kind: "challenge" });
  });

  it("parses Basic credentials and compares secrets exactly", () => {
    expect(basicPassword(basic("u", "p"))).toBe("p");
    expect(basicPassword(`basic ${Buffer.from("u:").toString("base64")}`)).toBe("");
    expect(sameSecret("abc", "abc")).toBe(true);
    expect(sameSecret("abc", "abd")).toBe(false);
    expect(sameSecret("abc", "abcd")).toBe(false);
  });
});
