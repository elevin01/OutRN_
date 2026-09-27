import type { ApiRequestError } from "../lib/api";

/** What went wrong talking to the API, in plain words. */
export function ApiProblem({ error }: { error: ApiRequestError }) {
  const fields = error.detail?.fields ?? [];
  const title =
    error.code === "VALIDATION_FAILED" ? "That search can’t run as asked."
      : error.code === "CURSOR_INVALID" ? "That page link has expired."
        : error.retryable ? "OutRN can’t be reached right now."
          : "Something went wrong.";
  return (
    <div className="honest-empty" role="alert">
      <strong>{title}</strong>
      <span>
        {fields.length ? fields.map((f) => `${f.path}: ${f.message}`).join("; ") : error.message}
        {error.retryable ? " Try again in a moment." : ""}
      </span>
    </div>
  );
}
