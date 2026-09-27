import { NextResponse, type NextRequest } from "next/server";
import { OPS_CHALLENGE, opsAccess, opsConfigFromEnv } from "./lib/ops-auth";

/**
 * Ops pages need an operator. Anonymous or wrong credentials get a Basic-auth challenge; with no
 * token configured, a production build serves no ops pages at all. Each ops page re-checks
 * (lib/ops.ts) and forwards only the visitor's own credential to the API, which checks it again.
 */
export function proxy(request: NextRequest) {
  const access = opsAccess(request.headers.get("authorization"), opsConfigFromEnv());
  if (access.kind === "allow") return NextResponse.next();
  if (access.kind === "disabled") return new NextResponse("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  return new NextResponse("Operator sign-in required.", { status: 401, headers: { "WWW-Authenticate": OPS_CHALLENGE, "cache-control": "no-store" } });
}

export const config = { matcher: ["/ops", "/ops/:path*"] };
