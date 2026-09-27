import "server-only";

import {
  ApiError,
  AreasResponse,
  OpsRunDetail,
  OpsRunList,
  PlaceDetails,
  RecommendationResponse,
  type RecommendationRequest,
  type RecommendationsBody,
} from "@outrn/contracts";
import type { z } from "zod/v4";

/**
 * The UI's only way to the backend: the v1 HTTP API described by @outrn/contracts. Point it at the
 * real API or the mock with OUTRN_API_URL; the UI cannot tell the difference. Every response is
 * checked against the contract, so a mismatch fails here with a clear message.
 */

const API_URL = (process.env["OUTRN_API_URL"] ?? "http://127.0.0.1:4000").replace(/\/$/, "");
const OPS_TOKEN = process.env["OUTRN_OPS_TOKEN"];

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    /** A contract error code (VALIDATION_FAILED, CURSOR_EXPIRED, …), or UNREACHABLE / CONTRACT_MISMATCH from this client. */
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly detail: ApiError["error"] | null = null,
  ) {
    super(message);
  }
}

async function request<T extends z.ZodType>(schema: T, path: string, init: { method?: "GET" | "POST"; body?: unknown; ops?: boolean } = {}): Promise<z.infer<T>> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: init.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.ops && OPS_TOKEN ? { authorization: `Bearer ${OPS_TOKEN}` } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      cache: "no-store",
    });
  } catch {
    throw new ApiRequestError(503, "UNREACHABLE", `Could not reach the OutRN API at ${API_URL}.`, true);
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error = ApiError.safeParse(json);
    if (error.success) throw new ApiRequestError(res.status, error.data.error.code, error.data.error.message, error.data.error.retryable, error.data.error);
    throw new ApiRequestError(res.status, "UNKNOWN", `The API answered ${res.status}.`, res.status >= 500);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ApiRequestError(502, "CONTRACT_MISMATCH", `The API response for ${path} does not match the contract (${issues}).`, false);
  }
  return parsed.data;
}

export const api = {
  areas: () => request(AreasResponse, "/v1/areas"),
  recommendations: (body: RecommendationsBody) => request(RecommendationResponse, "/v1/recommendations", { method: "POST", body }),
  place: (id: string) => request(PlaceDetails, `/v1/places/${encodeURIComponent(id)}`),
  ops: {
    evaluate: (body: RecommendationRequest) => request(OpsRunDetail, "/ops/v1/evaluate", { method: "POST", body, ops: true }),
    runs: (limit = 20) => request(OpsRunList, `/ops/v1/runs?limit=${limit}`, { ops: true }),
    run: (id: string) => request(OpsRunDetail, `/ops/v1/runs/${encodeURIComponent(id)}`, { ops: true }),
  },
};
