import { ZodError } from "zod";
import { FetchBlocked, FetchFailed } from "./fetch.js";

/**
 * A keyed API's failure, in words that cannot carry its key: the HTTP status, or what kind of failure
 * it was. Never the response body (an API or a proxy may echo the request back, key and all), never the
 * URL, a parser's snippet of what it read, or the error underneath. For every call that sends a key.
 */
export function keySafeError(source: string, e: unknown): Error {
  if (e instanceof FetchFailed) return new Error(e.status ? `${source}: the API answered ${e.status}` : `${source}: the API could not be reached`);
  if (e instanceof FetchBlocked) return new Error(`${source}: the API's answer was refused (not JSON, too large, or redirected)`);
  if (e instanceof SyntaxError) return new Error(`${source}: the API's answer was not JSON`);
  if (e instanceof ZodError) return new Error(`${source}: the API's answer was not in the shape expected`);
  return new Error(`${source}: the API could not be read`);
}

/** Runs a call that sends a key; whatever it throws comes out as keySafeError's words. */
export async function withKey<T>(source: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    throw keySafeError(source, e);
  }
}
