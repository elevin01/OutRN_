import type {
  AgeLimit,
  Price,
  RecommendationItem,
  RecommendationResponse,
} from "@outrn/contracts";
export const duration = (minutes: number) =>
  minutes < 60
    ? `${minutes} min`
    : `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
export const clock = (iso: string, timezone: string) =>
  new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(iso));
export function priceLabel(price: Price): string {
  if (price.kind === "unknown") return "Price unknown";
  const prefix =
    price.evidence === "estimate"
      ? "Est. "
      : price.evidence === "reported"
        ? "Reported: "
        : "";
  if (price.kind === "free") return `${prefix}Free`;
  const money = (n: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: price.currency,
      maximumFractionDigits: n % 100 ? 2 : 0,
    }).format(n / 100);
  const amount =
    price.minCents === null
      ? price.maxCents === null
        ? "Paid · amount unknown"
        : `Up to ${money(price.maxCents)}`
      : price.maxCents === null
        ? `From ${money(price.minCents)}`
        : price.maxCents === price.minCents
          ? money(price.minCents)
          : `${money(price.minCents)}–${money(price.maxCents)}`;
  return `${prefix}${amount}${price.per === "group" ? " / group" : " / person"}`;
}
export const ageLabel = (age: AgeLimit) =>
  `${age.evidence === "estimate" ? "Usually " : age.evidence === "reported" ? "Reported: " : ""}${age.minAge}+`;
export const travelLabel = (item: RecommendationItem) =>
  `${item.timing.travel.isEstimate ? "~" : ""}${item.timing.travel.minutes} min ${item.timing.travel.mode}`;
/**
 * What a card says the place offers, as the API states it: cuisines, then diets and must-haves.
 * Each label once, at most four.
 */
export function tagLabels(
  item: Pick<RecommendationItem, "cuisines" | "diets" | "features">,
): string[] {
  const labels = [
    ...item.cuisines.map((c) => c.label),
    ...item.diets.map((d) => d.label),
    ...item.features.map((f) => f.label),
  ];
  return [...new Set(labels)].slice(0, 4);
}
/**
 * What to expect there, briefly, for a card: a busy or quiet crowd, a wait's range, and weather that
 * changes the plan (rain, cold, heat). Kinds and levels this app doesn't know are left to the full
 * texts (`conditions[].text`).
 */
export function conditionBriefs(
  item: Pick<RecommendationItem, "conditions">,
): string[] {
  const out: string[] = [];
  for (const c of item.conditions) {
    const reported = c.basis === "report";
    if (c.kind === "crowd" && (c.level === "busy" || c.level === "quiet"))
      out.push(`${reported ? "Reported" : "Usually"} ${c.level}`);
    else if (c.kind === "wait" && c.minutes)
      out.push(`~${c.minutes.min}–${c.minutes.max} min wait`);
    else if (c.kind === "wait" && reported && c.level !== "none")
      out.push(`${c.level === "long" ? "Long" : "Short"} line reported`);
    else if (
      c.kind === "weather" &&
      (c.level === "rain" || c.level === "cold" || c.level === "hot")
    )
      out.push(c.text);
  }
  return out;
}
/** Keep eligibility and admission separate: a feasible visit can still require booking. */
export const actionLabel = (
  item: Pick<RecommendationItem, "status" | "callToAction">,
) =>
  item.callToAction === "book"
    ? "Book first"
    : item.status === "check_first" || item.callToAction === "check"
      ? "Check first"
      : "Go now";
export const nowIcon = (hour: number): "sun" | "moon" =>
  hour >= 6 && hour < 18 ? "sun" : "moon";
export const isExpired = (
  response: Pick<RecommendationResponse, "expiresAt">,
  now = Date.now(),
) => new Date(response.expiresAt).getTime() <= now;
/** Never launch an arbitrary scheme supplied by a source. */
export function safeExternalUrl(value: string, phone = false): string | null {
  if (phone)
    return /^[+\d ()-]+$/.test(value)
      ? `tel:${value.replace(/[^+\d]/g, "")}`
      : null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
