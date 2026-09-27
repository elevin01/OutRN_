import { useEffect, useState } from "react";
import { View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import type { PlaceDetails } from "@outrn/contracts";
import { api, demoMode, RequestError } from "../../lib/api";
import { useApp } from "../../state/app";
import {
  ageLabel,
  clock,
  duration,
  isExpired,
  priceLabel,
  travelLabel,
} from "../../lib/presentation";
import {
  Button,
  Copy,
  Eyebrow,
  Heading,
  IconButton,
  Loading,
  Panel,
  Problem,
  Row,
  Screen,
  colors,
  s,
} from "../../components/ui";
import { PlaceArt } from "../../components/PlaceArt";
import { RequiredNotes } from "../../components/PlaceCard";
import { ExternalButton } from "../../components/ExternalButton";
export default function PlaceScreen() {
  const { id, itemId } = useLocalSearchParams<{
    id: string;
    itemId?: string;
  }>();
  const {
    result,
    saved,
    toggleSaved,
    hydrated,
    storageError,
    setOuting,
    query,
    search,
  } = useApp();
  const [resource, setResource] = useState<{
    key: string;
    place?: PlaceDetails;
    error?: RequestError;
  }>();
  const [attempt, setAttempt] = useState(0);
  const resourceKey = `${id}:${attempt}`;
  const place = resource?.key === resourceKey ? resource.place : undefined;
  const error = resource?.key === resourceKey ? resource.error : undefined;
  const [now, setNow] = useState(() => Date.now());
  const item = result?.items.find((i) => i.id === itemId && i.placeId === id);
  const expired = !!result && !demoMode && isExpired(result, now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    api
      .place(id, controller.signal)
      .then((p) => {
        if (!controller.signal.aborted)
          setResource({ key: resourceKey, place: p });
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setResource({ key: resourceKey, error: e });
      });
    return () => controller.abort();
  }, [id, resourceKey]);
  const back = () => (router.canGoBack() ? router.back() : router.replace("/"));
  const closed =
    place?.status === "closed_permanently" ||
    place?.status === "closed_temporarily";
  const canPlan = !!item && !!place && !closed && !expired;
  const start = () => {
    if (!item || !result || !place || closed) return;
    if (!demoMode && isExpired(result)) {
      setNow(Date.now());
      return;
    }
    setOuting({
      item,
      timezone: result.area.timezone,
      expiresAt: result.expiresAt,
      arrived: false,
    });
    router.push("/outing");
  };
  const reloadSearch = () => {
    if (query) void search(query);
    router.replace("/");
  };
  return (
    <Screen
      footer={
        place ? (
          canPlan ? (
            <Button
              label={
                item!.callToAction === "go"
                  ? "Let’s go"
                  : item!.callToAction === "book"
                    ? "Review booking & plan"
                    : "Review & plan"
              }
              onPress={start}
              icon="arrow-right"
            />
          ) : (
            <Button label="Find fresh options" onPress={reloadSearch} />
          )
        ) : undefined
      }
    >
      <Row style={s.between}>
        <IconButton name="arrow-left" label="Back" onPress={back} />
        {place && hydrated && (
          <IconButton
            name="bookmark"
            selected={saved.some((x) => x.id === id)}
            label={
              saved.some((x) => x.id === id)
                ? "Remove from saved"
                : "Save this place"
            }
            onPress={() =>
              toggleSaved({ id, name: place.name, category: place.category.id })
            }
          />
        )}
      </Row>
      {error ? (
        <Problem
          message={error.message}
          retry={error.retryable ? () => setAttempt((a) => a + 1) : undefined}
        />
      ) : !place ? (
        <Loading label="Getting the details…" />
      ) : (
        <>
          <View style={{ borderRadius: 24, overflow: "hidden" }}>
            <PlaceArt category={place.category.id} />
          </View>
          <Eyebrow>
            {place.category.label}
            {item?.kind === "event" ? " · Event" : ""}
          </Eyebrow>
          <Heading>{item?.name || place.name}</Heading>
          {item?.kind === "event" && <Copy>At {place.name}</Copy>}
          {storageError && (
            <Copy accessibilityRole="alert">{storageError}</Copy>
          )}
          {(expired || closed) && (
            <Panel warm>
              <Copy style={{ fontWeight: "700" }}>
                {closed
                  ? "This place is no longer listed as operating."
                  : "This plan needs a refresh."}
              </Copy>
              <Copy>Find fresh options before heading out.</Copy>
            </Panel>
          )}
          {!item && (
            <Copy style={s.muted}>
              Place details only. Find fresh options to check whether a visit
              fits your time.
            </Copy>
          )}
          {item && (
            <>
              <Panel>
                <Eyebrow>
                  {item.status === "ready"
                    ? "Your time, well spent"
                    : "A few things to check"}
                </Eyebrow>
                <Copy style={{ fontWeight: "600" }}>
                  {travelLabel(item)} · {duration(item.timing.usefulMinutes)}{" "}
                  there
                </Copy>
                <Copy>{priceLabel(item.price)}</Copy>
                {item.copy.sentence && <Copy>{item.copy.sentence}</Copy>}
                <RequiredNotes item={item} />
                {item.timing.travel.parkingMinutes !== null && (
                  <Copy>
                    Travel includes {item.timing.travel.parkingMinutes} min
                    allowed for parking. Availability is unknown.
                  </Copy>
                )}
              </Panel>
              <View style={{ gap: 12 }}>
                <Eyebrow>The plan</Eyebrow>
                {[
                  [
                    clock(item.timing.leaveAt, result!.area.timezone),
                    "Leave the area center",
                  ],
                  [
                    clock(item.timing.arriveAt, result!.area.timezone),
                    "Estimated arrival",
                  ],
                  [
                    clock(item.timing.finishBy, result!.area.timezone),
                    "Finish your visit",
                  ],
                ].map(([time, label]) => (
                  <Row key={label}>
                    <Copy style={{ width: 90, fontWeight: "700" }}>{time}</Copy>
                    <Copy style={s.muted}>{label}</Copy>
                  </Row>
                ))}
                <Copy style={[s.muted, { fontSize: 12 }]}>
                  Times in {result!.area.timezone}. Finish time is not a
                  return-home deadline.
                </Copy>
              </View>
            </>
          )}
          <View style={s.divider} />
          <Heading>What we know.</Heading>
          {place.address && <Copy>{place.address}</Copy>}
          <Copy>{priceLabel(place.price)}</Copy>
          {place.ageLimit && (
            <Copy style={{ color: colors.accent }}>
              {ageLabel(place.ageLimit)}
            </Copy>
          )}
          {place.facts.map((fact, index) => (
            <View
              key={`${fact.attribute}-${index}`}
              style={{
                gap: 5,
                paddingBottom: 16,
                borderBottomWidth: 1,
                borderColor: colors.border,
              }}
            >
              <Eyebrow>
                {fact.label} · {fact.provenance.evidence}
              </Eyebrow>
              <Copy style={{ fontWeight: "600" }}>{fact.value}</Copy>
              {fact.detail && <Copy>{fact.detail}</Copy>}
              <Copy style={[s.muted, { fontSize: 13 }]}>
                {fact.provenance.summary}
              </Copy>
              {fact.provenance.conflict && (
                <Copy style={{ color: colors.accent }}>
                  Sources disagree. Check with the venue.
                </Copy>
              )}
              {fact.provenance.dueForRecheck && (
                <Copy style={{ color: colors.accent }}>
                  Due for another check.
                </Copy>
              )}
            </View>
          ))}
          {place.contact.websiteUrl && (
            <ExternalButton
              label="Visit website"
              url={place.contact.websiteUrl}
            />
          )}
          {place.contact.phone && (
            <ExternalButton
              label="Call the venue"
              url={place.contact.phone}
              phone
            />
          )}
          <Copy style={[s.muted, { fontSize: 12 }]}>
            {place.attributions.join(" · ")}
          </Copy>
        </>
      )}
    </Screen>
  );
}
