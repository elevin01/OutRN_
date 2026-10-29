import Anthropic from "@anthropic-ai/sdk";

/**
 * Asking Claude for JSON (structured outputs), and what each answer cost. Used by the jobs that read
 * venues' pages no structured data describes (site-ai.ts); never in the request path. The key comes
 * from the environment (ANTHROPIC_API_KEY, or the SDK's other credential sources) and is never logged.
 */

/** OUTRN_AI_MODEL overrides it. */
export const AI_DEFAULT_MODEL = "claude-opus-5-5";

/** Dollars per million tokens (input, output), Anthropic's first-party rates. */
const PRICES: Readonly<Record<string, { input: number; output: number }>> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-fable-5-1": { input: 10, output: 50 },
};
/** A model we have no price for is counted at the dearest we know: a spending cap is never under-counted. */
const UNKNOWN_PRICE = { input: 10, output: 50 };

export function priceOf(model: string): { input: number; output: number } {
  return Object.hasOwn(PRICES, model) ? PRICES[model]! : UNKNOWN_PRICE;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** What a response cost, in dollars: cache writes at 1.25× input, cache reads at 0.1×. */
export function costOf(model: string, u: TokenUsage): number {
  const p = priceOf(model);
  const input = u.input_tokens + 1.25 * (u.cache_creation_input_tokens ?? 0) + 0.1 * (u.cache_read_input_tokens ?? 0);
  return (input * p.input + u.output_tokens * p.output) / 1_000_000;
}

/** The most a request can cost before it is sent: its text at about three characters a token, and every output token it may write. */
export function worstCaseCost(model: string, chars: number, maxTokens: number): number {
  const p = priceOf(model);
  return (Math.ceil(chars / 3) * p.input + maxTokens * p.output) / 1_000_000;
}

export interface JsonQuestion {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens: number;
}

export interface JsonAnswer {
  /** The parsed JSON, or null when the answer was cut short, declined, or not JSON. */
  data: unknown;
  stopReason: string;
  model: string;
  costUsd: number;
}

/** What asks a question: Claude in production, a stand-in in tests. */
export type Asker = (q: JsonQuestion) => Promise<JsonAnswer>;

/** Models that take server-side refusal fallbacks (fallbacks: "default"). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1"]);

/** `apiKey`: from the environment the caller checked (else the SDK finds its own credentials). */
export function claudeAsker(model: string, apiKey?: string): Asker {
  const client = new Anthropic(apiKey ? { apiKey } : {});
  return async (q) => {
    const params = {
      model,
      max_tokens: q.maxTokens,
      // Reading a page is a simple task: little thinking, less spend.
      output_config: { effort: "low" as const, format: { type: "json_schema" as const, schema: q.schema } },
      system: q.system,
      messages: [{ role: "user" as const, content: q.user }],
    };
    // A declined request is re-run on Anthropic's recommended fallback, where the model takes one.
    let r: Awaited<ReturnType<typeof client.beta.messages.create>>;
    try {
      r = FALLBACK_MODELS.has(model) ? await client.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }) : await client.beta.messages.create(params);
    } catch (e) {
      // Its status, never the body or the request: what any keyed API's failure says here (see withKey).
      if (e instanceof Anthropic.APIError) throw new Error(`claude: the API answered ${e.status ?? "with an error"}`);
      throw new Error("claude: the API could not be reached");
    }
    const costUsd = costOf(r.model, r.usage);
    if (r.stop_reason !== "end_turn") return { data: null, stopReason: r.stop_reason ?? "unknown", model: r.model, costUsd };
    const text = r.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    try {
      return { data: JSON.parse(text), stopReason: r.stop_reason, model: r.model, costUsd };
    } catch {
      return { data: null, stopReason: "not_json", model: r.model, costUsd };
    }
  };
}
