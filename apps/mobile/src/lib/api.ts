import {
  ApiError,
  AreasResponse,
  PlaceDetails,
  RecommendationResponse,
  type RecommendationsBody,
} from "@outrn/contracts";

export class RequestError extends Error {
  constructor(
    message: string,
    readonly code = "UNREACHABLE",
    readonly retryable = true,
    readonly restart?: RecommendationsBody,
    readonly fields?: { path: string; message: string }[],
  ) {
    super(message);
  }
}
type Schema<T> = {
  safeParse: (
    value: unknown,
  ) => { success: true; data: T } | { success: false };
};
export function createApi(baseUrl: string, transport: typeof fetch = fetch) {
  async function request<T>(
    path: string,
    schema: Schema<T>,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort);
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(abort, 15_000);
    try {
      const response = await transport(`${baseUrl.replace(/\/$/, "")}${path}`, {
        signal: controller.signal,
        method: body ? "POST" : "GET",
        headers: {
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const json: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const parsed = ApiError.safeParse(json);
        if (parsed.success) {
          const e = parsed.data.error;
          throw new RequestError(
            e.message,
            e.code,
            e.retryable,
            e.restart,
            e.fields,
          );
        }
        throw new RequestError(
          "Something went wrong. Please try again.",
          "HTTP_ERROR",
          response.status >= 500,
        );
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success)
        throw new RequestError(
          "These details could not be read. Please try again later.",
          "CONTRACT_MISMATCH",
          false,
        );
      return parsed.data;
    } catch (error) {
      if (error instanceof RequestError) throw error;
      throw new RequestError(
        "We couldn’t connect. Check your connection and try again.",
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  return {
    areas: (signal?: AbortSignal) =>
      request("/v1/areas", AreasResponse, undefined, signal),
    recommend: (body: RecommendationsBody, signal?: AbortSignal) =>
      request("/v1/recommendations", RecommendationResponse, body, signal),
    place: (id: string, signal?: AbortSignal) =>
      request(
        `/v1/places/${encodeURIComponent(id)}`,
        PlaceDetails,
        undefined,
        signal,
      ),
  };
}
/** Parse the authority rather than matching a prefix (localhost@evil is not loopback). */
export function resolveApiUrl(
  configured: string | undefined,
  dev: boolean,
): string {
  const value = configured?.trim() || (dev ? "http://127.0.0.1:4000" : "");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("EXPO_PUBLIC_API_URL must be the API's https:// address.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (!dev && url.protocol !== "https:" && !loopback)
  ) {
    throw new Error(
      "EXPO_PUBLIC_API_URL must use HTTPS in a release build (local loopback previews excepted).",
    );
  }
  return url.toString().replace(/\/$/, "");
}
export const demoMode = process.env.EXPO_PUBLIC_DEMO_MODE === "true";
export const api = createApi(
  resolveApiUrl(
    process.env.EXPO_PUBLIC_API_URL,
    typeof __DEV__ === "undefined"
      ? process.env.NODE_ENV !== "production"
      : __DEV__,
  ),
);
