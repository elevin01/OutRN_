import { useEffect, useRef, useState, type ReactNode } from "react";
import { router } from "expo-router";
import type { RecommendationResponse } from "@outrn/contracts";
import { useApp } from "../../state/app";
import {
  Button,
  Copy,
  Heading,
  IconButton,
  Loading,
  Panel,
  Problem,
  Row,
  Screen,
  s,
} from "../../components/ui";
import { ActivityExperience } from "../../components/ActivityExperience";
import { HappeningPill } from "../../components/HappeningPill";
import { happeningSoon } from "../../lib/happening";
import { demoMode } from "../../lib/api";
import { isExpired } from "../../lib/presentation";

export default function NowScreen() {
  const {
    areas,
    query,
    result,
    busy,
    error,
    search,
    initialize,
    taste,
    tasteHydrated,
    happening,
    hiddenNudges,
    hideNudge,
  } = useApp();
  const [backPage, setBackPage] = useState<string>();
  // Quick picks, once, on first open: what this person likes leads from the first search on.
  const offeredPicks = useRef(false);
  useEffect(() => {
    if (
      offeredPicks.current ||
      !tasteHydrated ||
      taste.asked ||
      !areas?.filters.interests.length
    )
      return;
    offeredPicks.current = true;
    router.push("/interests");
  }, [tasteHydrated, taste.asked, areas]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const refresh = () => {
    setBackPage(undefined);
    if (query) void search(query);
    else void initialize();
  };
  const expired = result && !demoMode && isExpired(result, now);
  // Happening soon: an event starting within two hours, one this person loves first; not one already
  // on the shortlist, and not one hidden this session.
  const happeningNow = demoMode && happening ? Date.parse(happening.asOf) : now;
  const nudge = happeningSoon(
    happening && {
      ...happening,
      items: happening.items.filter(
        (i) =>
          !hiddenNudges.has(i.id) && !result?.items.some((r) => r.id === i.id),
      ),
    },
    happeningNow,
  );
  if (!busy && !error && result && !expired && areas?.areas.length)
    return (
      <ActivityDeck
        key={`${result.requestId}:${result.page.offset}`}
        result={result}
        refresh={refresh}
        startAtEnd={backPage === `${result.requestId}:${result.page.offset}`}
        banner={
          nudge && happening ? (
            <HappeningPill
              item={nudge}
              timezone={happening.area.timezone}
              now={happeningNow}
              onOpen={() => router.push({ pathname: "/happening", params: { id: nudge.id } })}
              onHide={() => hideNudge(nudge.id)}
            />
          ) : undefined
        }
        page={(cursor, backwards) => {
          setBackPage(
            backwards
              ? `${result.requestId}:${Math.max(0, result.page.offset - result.page.size)}`
              : undefined,
          );
          void search({ cursor });
        }}
      />
    );
  return (
    <Screen>
      <Row style={s.between}>
        <Heading>OutRN</Heading>
        <IconButton
          name="sliders"
          label="Plans & preferences"
          onPress={() => router.push("/filters")}
        />
      </Row>
      {busy ? (
        <Loading label="Finding nearby activities…" />
      ) : error ? (
        <Problem
          message={error.message}
          retry={
            error.retryable || error.code.startsWith("CURSOR_")
              ? () => {
                  if (error.restart || query)
                    void search((error.restart || query)!);
                  else void initialize();
                }
              : undefined
          }
          label={
            error.code.startsWith("CURSOR_")
              ? "Find fresh options"
              : "Try again"
          }
        />
      ) : expired ? (
        <Panel warm>
          <Heading>Find something for now</Heading>
          <Copy>
            These recommendations have expired. Refresh before heading out.
          </Copy>
          <Button label="Find fresh options" onPress={refresh} />
        </Panel>
      ) : (
        <Panel>
          <Heading>More places soon</Heading>
          <Copy>There are no supported areas yet.</Copy>
          <Button label="Check again" onPress={refresh} />
        </Panel>
      )}
    </Screen>
  );
}
function ActivityDeck({
  result,
  startAtEnd,
  page,
  refresh,
  banner,
}: {
  result: RecommendationResponse;
  startAtEnd: boolean;
  page: (cursor: string, backwards: boolean) => void;
  refresh: () => void;
  banner?: ReactNode;
}) {
  const [index, setIndex] = useState(
    startAtEnd ? Math.max(0, result.items.length - 1) : 0,
  );
  const item = result.items[index];
  const previous =
    index > 0
      ? () => setIndex((i) => i - 1)
      : result.page.prevCursor
        ? () => page(result.page.prevCursor!, true)
        : undefined;
  const next = () => {
    if (index < result.items.length - 1) setIndex((i) => i + 1);
    else if (result.page.nextCursor) page(result.page.nextCursor, false);
    else setIndex(result.items.length);
  };
  if (item)
    return (
      <ActivityExperience
        key={item.id}
        placeId={item.placeId}
        item={item}
        response={result}
        position={result.page.offset + index + 1}
        onPrevious={previous}
        onNext={next}
        onRefresh={refresh}
        banner={banner}
      />
    );
  return (
    <Screen>
      <Heading>
        {result.items.length
          ? "That’s your shortlist"
          : "Nothing fits this search"}
      </Heading>
      <Copy>
        {result.items.length
          ? "Revisit an activity or find some fresh options."
          : "Try a different time, budget, or kind of place."}
      </Copy>
      {previous && (
        <Button label="Previous activity" onPress={previous} secondary />
      )}
      <Button label="Find fresh options" onPress={refresh} />
      <Button
        label="Plans & preferences"
        secondary
        onPress={() => router.push("/filters")}
      />
      {result.insufficient?.relaxations.map((r) => (
        <Copy key={r.code}>
          {r.text} · {r.admits} more
        </Copy>
      ))}
      <Copy style={s.muted}>{result.attributions.join(" · ")}</Copy>
    </Screen>
  );
}
