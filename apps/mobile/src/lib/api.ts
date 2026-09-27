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
          throw new RequestError(e.message, e.code, e.retryable, e.restart);
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
export const demoMode = process.env.EXPO_PUBLIC_DEMO_MODE === "true";
export const api = createApi(
  process.env.EXPO_PUBLIC_API_URL || "http://127.0.0.1:4000",
);
