import { z } from "zod/v4";
import { RecommendationRequest } from "./recommendations.js";

/**
 * Every non-2xx response has this body. `code` is open-ended: handle the ones you know and treat
 * any other by `retryable`.
 */
export const ERROR_CODES = {
  /** 400: the request failed validation; `fields` says where. */
  VALIDATION_FAILED: 400,
  /** 400: the cursor is malformed or unknown. Start a new search. */
  CURSOR_INVALID: 400,
  /** 401: ops routes only. */
  UNAUTHORIZED: 401,
  /** 404 */
  NOT_FOUND: 404,
  /** 410: the search's pages expired. `restart` is the same search to run again. */
  CURSOR_EXPIRED: 410,
  /** 503: the backend or its database is unavailable. Retryable. */
  UNAVAILABLE: 503,
  /** 500 */
  INTERNAL: 500,
} as const;
export type KnownErrorCode = keyof typeof ERROR_CODES;

export const FieldError = z.object({ path: z.string(), message: z.string() });

export const ApiError = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    retryable: z.boolean(),
    fields: z.array(FieldError).optional(),
    /** CURSOR_EXPIRED only: the original search, to run again as a new request. */
    restart: RecommendationRequest.optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;
