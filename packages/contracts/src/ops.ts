import { z } from "zod/v4";
import { IsoDateTime } from "./common.js";

/**
 * /ops/v1/* — diagnostics for operators, behind a bearer token. Not part of the consumer API:
 * these expose every candidate, exclusion codes and scores, which the consumer screens must not.
 */

export const OpsCandidate = z.object({
  itemId: z.string(),
  kind: z.enum(["venue", "event"]),
  /** Null only for a stored run whose place no longer exists. */
  placeId: z.string().nullable(),
  name: z.string(),
  category: z.string(),
  class: z.enum(["ready", "check_first", "ineligible"]),
  /** The gate that excluded it, e.g. "CLOSED_ON_ARRIVAL". */
  excludedBy: z.string().nullable(),
  reasons: z.array(z.string()),
  unresolved: z.array(z.string()),
  travelMinutes: z.int().nullable(),
  usefulMinutes: z.int().nullable(),
  /** `taste`: the match with the request's taste and mood (0.5 neutral); null when it had neither, and in stored runs. */
  scores: z.object({ evidence: z.number(), fit: z.number(), appeal: z.number(), novelty: z.number(), taste: z.number().nullable() }),
  shortlisted: z.boolean(),
});
export type OpsCandidate = z.infer<typeof OpsCandidate>;

export const OpsRunSummary = z.object({
  id: z.uuid(),
  areaName: z.string().nullable(),
  createdAt: IsoDateTime,
  candidateCount: z.int(),
  durationMs: z.int().nullable(),
  engineVersion: z.string(),
  weightsVersion: z.string(),
});
export type OpsRunSummary = z.infer<typeof OpsRunSummary>;

export const OpsRunList = z.object({ runs: z.array(OpsRunSummary) });
export type OpsRunList = z.infer<typeof OpsRunList>;

export const OpsRunDetail = OpsRunSummary.extend({
  /** The engine context as recorded (coarsened origin). */
  context: z.record(z.string(), z.unknown()),
  counts: z.object({ total: z.int(), ready: z.int(), check_first: z.int(), ineligible: z.int() }),
  results: z.array(OpsCandidate),
});
export type OpsRunDetail = z.infer<typeof OpsRunDetail>;
