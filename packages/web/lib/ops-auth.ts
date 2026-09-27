/**
 * Who may see the ops pages. Pure (no Next imports) so the proxy, the pages and the tests share it.
 *
 * Operators sign in with HTTP Basic auth: any username, the ops token as the password. The web app
 * checks it here, then forwards the visitor's own credential to the API, which checks it again. The
 * web app never attaches a credential the visitor did not present.
 */

export type OpsAccess =
  /** `bearer`: the visitor's own credential to forward, or null (development without a token). */
  | { kind: "allow"; bearer: string | null }
  /** Ask for credentials (401 + WWW-Authenticate). */
  | { kind: "challenge" }
  /** This deployment serves no ops pages (404). */
  | { kind: "disabled" };

export interface OpsAuthConfig {
  /** OUTRN_OPS_TOKEN: the password operators must present. */
  token: string | undefined;
  nodeEnv: string | undefined;
}

export const OPS_CHALLENGE = 'Basic realm="OutRN ops", charset="UTF-8"';

/** The password from an `Authorization: Basic …` header, or null. */
export function basicPassword(authorization: string | null | undefined): string | null {
  const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})\s*$/i.exec(authorization ?? "");
  if (!match) return null;
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon === -1 ? null : decoded.slice(colon + 1);
}

/**
 * Compare without an early exit. The loop runs over the secret whatever was presented, so timing
 * reveals neither how much of a guess was right nor the secret's length.
 */
export function sameSecret(presented: string, secret: string): boolean {
  let diff = presented.length ^ secret.length;
  for (let i = 0; i < secret.length; i++) diff |= (presented.charCodeAt(i) | 0) ^ secret.charCodeAt(i);
  return diff === 0;
}

export function opsAccess(authorization: string | null | undefined, config: OpsAuthConfig): OpsAccess {
  const token = config.token || undefined;
  // No token: open only while developing (the API's own rule); a production build serves no ops pages.
  if (!token) return config.nodeEnv === "development" ? { kind: "allow", bearer: null } : { kind: "disabled" };
  const password = basicPassword(authorization);
  return password !== null && sameSecret(password, token) ? { kind: "allow", bearer: password } : { kind: "challenge" };
}

export function opsConfigFromEnv(): OpsAuthConfig {
  return { token: process.env["OUTRN_OPS_TOKEN"], nodeEnv: process.env["NODE_ENV"] };
}
