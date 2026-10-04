import { useEffect, useState } from "react";
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
import { demoMode } from "../../lib/api";
import { isExpired } from "../../lib/presentation";
import { FirstPickLoading } from "../../components/OnboardingChrome";

export default function NowScreen() {
  const {
    areas,
    query,
    result,
    busy,
    error,
    search,
    initialize,
    firstArrival,
  } = useApp();
  const [backPage, setBackPage] = useState<string>();
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
  if (busy && firstArrival) return <FirstPickLoading />;
  if (!busy && !error && result && !expired && areas?.areas.length)
    return (
      <ActivityDeck
        key={`${result.requestId}:${result.page.offset}`}
        result={result}
        refresh={refresh}
        startAtEnd={backPage === `${result.requestId}:${result.page.offset}`}
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
}: {
  result: RecommendationResponse;
  startAtEnd: boolean;
  page: (cursor: string, backwards: boolean) => void;
  refresh: () => void;
}) {
  const { firstArrival, dismissArrival } = useApp();
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
    dismissArrival();
    if (index < result.items.length - 1) setIndex((i) => i + 1);
    else if (result.page.nextCursor) page(result.page.nextCursor, false);
    else setIndex(result.items.length);
  };
  if (item)
    return (
      <ActivityExperience
        introduction={
          firstArrival && index === 0 && result.page.offset === 0
            ? "Here’s a good place to start."
            : undefined
        }
        key={item.id}
        placeId={item.placeId}
        item={item}
        response={result}
        position={result.page.offset + index + 1}
        onPrevious={previous}
        onNext={next}
        onRefresh={refresh}
      />
    );
  return (
    <Screen>
      <Heading>
        {result.items.length
          ? "That’s your shortlist"
          : "Let’s try a little differently."}
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
      <Button
        label="Try another area"
        secondary
        onPress={() => router.push("/areas")}
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
