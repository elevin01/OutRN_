import { ERROR_CODES, type ApiError, type KnownErrorCode, type RecommendationRequest } from "@outrn/contracts";
import type { z } from "zod/v4";

/** A failure the API reports in the contract's ApiError shape. */
export class ApiProblem extends Error {
  constructor(
    readonly code: KnownErrorCode,
    message: string,
    readonly extra: { fields?: { path: string; message: string }[]; restart?: RecommendationRequest } = {},
  ) {
    super(message);
  }

  get status(): (typeof ERROR_CODES)[KnownErrorCode] {
    return ERROR_CODES[this.code];
  }

  get retryable(): boolean {
    return this.code === "UNAVAILABLE" || this.code === "INTERNAL";
  }

  body(): ApiError {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.extra.fields ? { fields: this.extra.fields } : {}),
        ...(this.extra.restart ? { restart: this.extra.restart } : {}),
      },
    };
  }
}

export function invalid(path: string, message: string): ApiProblem {
  return new ApiProblem("VALIDATION_FAILED", `${path}: ${message}`, { fields: [{ path, message }] });
}

export function fromZod(error: z.ZodError, what = "request"): ApiProblem {
  const fields = error.issues.map((i) => ({ path: i.path.map(String).join(".") || "(body)", message: i.message }));
  return new ApiProblem("VALIDATION_FAILED", `The ${what} is not valid: ${fields.map((f) => `${f.path}: ${f.message}`).join("; ")}`, { fields });
}

/** Postgres unreachable or refusing connections: a retryable outage, not a bug. */
export function isUnavailable(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "57P01", "57P03", "53300"].includes(code)) return true;
  return e instanceof Error && /DATABASE_URL is not set|Connection terminated|timeout exceeded when trying to connect/i.test(e.message);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string): boolean => UUID.test(s);
