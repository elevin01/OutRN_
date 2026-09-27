import { describe, expect, it } from "vitest";
import { ApiError } from "@outrn/contracts";
import { createApp, MAX_BODY_BYTES, openOpsAllowed, type AppOptions } from "./app.js";

/** The HTTP boundary's own guards. No database: a handler that is reached answers UNAVAILABLE. */

const noDb: AppOptions["db"] = () => {
  throw Object.assign(new Error("no db in this test"), { code: "ECONNREFUSED" });
};
const app = (opts: Partial<AppOptions> = {}) => createApp({ db: noDb, log: () => undefined, ...opts });
const code = async (res: Response) => ApiError.parse(await res.json()).error.code;

describe("ops routes", () => {
  it("are open without a token only under NODE_ENV=development", () => {
    expect(openOpsAllowed("development")).toBe(true);
    for (const env of [undefined, "", "production", "test", "staging", "Development"]) expect(openOpsAllowed(env), String(env)).toBe(false);
  });

  it("are disabled when there is no token and open ops are not allowed", async () => {
    const res = await app().request("/ops/v1/runs");
    expect([res.status, await code(res)]).toEqual([401, "UNAUTHORIZED"]);
  });

  it("need the exact bearer token", async () => {
    const withToken = app({ opsToken: "s3cret" });
    for (const authorization of [undefined, "", "Bearer s3cre", "Bearer s3cretx", "Bearer S3CRET", "Basic s3cret", "s3cret"]) {
      const res = await withToken.request("/ops/v1/runs", { headers: authorization === undefined ? {} : { authorization } });
      expect(res.status, String(authorization)).toBe(401);
    }
    // Past the check, the handler runs (and finds no database).
    const ok = await withToken.request("/ops/v1/runs", { headers: { authorization: "Bearer s3cret" } });
    expect([ok.status, await code(ok)]).toEqual([503, "UNAVAILABLE"]);
  });
});

describe("request bodies", () => {
  it("are refused past the size cap before they are read", async () => {
    const body = JSON.stringify({ areaId: "les", windowMinutes: 180, pad: "x".repeat(MAX_BODY_BYTES) });
    const res = await app().request("/v1/recommendations", { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(res.status).toBe(400);
    const error = ApiError.parse(await res.json()).error;
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.fields).toEqual([{ path: "(body)", message: "too large" }]);
  });

  it("are refused past the cap without a content-length too", async () => {
    const chunk = new TextEncoder().encode(" ".repeat(4096));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 8) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const res = await app().request("/v1/recommendations", { method: "POST", headers: { "content-type": "application/json", "transfer-encoding": "chunked" }, body: stream, duplex: "half" } as RequestInit);
    expect([res.status, await code(res)]).toEqual([400, "VALIDATION_FAILED"]);
  });

  it("under the cap reach the handler", async () => {
    const res = await app().request("/v1/recommendations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ areaId: "les", windowMinutes: 180 }) });
    expect([res.status, await code(res)]).toEqual([503, "UNAVAILABLE"]);
  });
});

it("tells browsers not to sniff response types", async () => {
  expect((await app().request("/healthz")).headers.get("x-content-type-options")).toBe("nosniff");
});
