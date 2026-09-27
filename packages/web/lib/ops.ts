import "server-only";

import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { opsAccess, opsConfigFromEnv } from "./ops-auth";

declare const verified: unique symbol;

/** Proof that this request passed the ops check. Carries the visitor's own credential, nothing else. */
export type OpsCredential = { readonly bearer: string | null; readonly [verified]: true };

/**
 * Call first in every ops page, before any ops data is fetched. The proxy has already challenged
 * anonymous visitors; this re-checks the request itself, so a proxy matcher gap cannot expose ops
 * data, and fails closed.
 */
export async function requireOps(): Promise<OpsCredential> {
  const access = opsAccess((await headers()).get("authorization"), opsConfigFromEnv());
  if (access.kind !== "allow") notFound();
  return { bearer: access.bearer } as OpsCredential;
}
