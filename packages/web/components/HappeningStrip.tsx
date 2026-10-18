import Link from "next/link";
import type { RecommendationItem } from "@outrn/contracts";
import { CategoryIcon } from "./CategoryIcon";

/** Happening soon: events starting within two hours from the events-only search beside this one. */
export function HappeningStrip({ items, timezone, now }: { items: RecommendationItem[]; timezone: string; now: number }) {
  if (!items.length) return null;
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: timezone });
  return (
    <section className="happening-strip" aria-labelledby="happening-title">
      <p className="eyebrow" id="happening-title"><CategoryIcon category="event_site" size={14} />Happening soon</p>
      <ul>
        {items.map((i) => {
          const starts = Date.parse(i.event!.startsAt);
          return (
            <li key={i.id}>
              <Link href={`/places/${i.placeId}?mode=${i.timing.travel.mode}`}>
                <strong>{i.name}</strong>
                <span>{starts <= now ? "on now" : time.format(starts)} · {i.placeName}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
