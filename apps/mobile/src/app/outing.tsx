import { useEffect, useState } from "react";
import { router } from "expo-router";
import { useApp } from "../state/app";
import { demoMode } from "../lib/api";
import { isExpired, travelLabel } from "../lib/presentation";
import {
  Button,
  Copy,
  Eyebrow,
  Heading,
  Icon,
  IconButton,
  Panel,
  Row,
  Screen,
  s,
} from "../components/ui";
import { ExternalButton } from "../components/ExternalButton";
import { RequiredNotes } from "../components/PlaceCard";
export default function OutingScreen() {
  const { outing, setOuting, query, search } = useApp();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  if (!outing)
    return (
      <Screen>
        <Heading>Where next?</Heading>
        <Copy>Choose somewhere from your shortlist to start an outing.</Copy>
        <Button label="Back to Now" onPress={() => router.replace("/")} />
      </Screen>
    );
  const { item, arrived } = outing;
  const expired = !demoMode && isExpired(outing, now);
  return (
    <Screen>
      <Row style={s.between}>
        <Eyebrow>{arrived ? "Arrived" : "Your outing"}</Eyebrow>
        <IconButton
          name="x"
          label="Back to Now"
          onPress={() => router.replace("/")}
        />
      </Row>
      <Heading>{item.name}</Heading>
      <Copy style={s.muted}>
        {arrived
          ? "Take your time. Keep the venue’s hours in mind."
          : "Check the latest details before leaving."}
      </Copy>
      <Panel>
        <Icon name={arrived ? "sun" : "navigation"} size={38} />
        <Heading>{item.name}</Heading>
        <Copy>{travelLabel(item)}</Copy>
        <RequiredNotes item={item} />
      </Panel>
      {expired && !arrived ? (
        <Panel warm>
          <Copy>
            This plan has expired. Refresh your options before heading out.
          </Copy>
          <Button
            label="Find fresh options"
            onPress={() => {
              setOuting(undefined);
              if (query) void search(query);
              router.replace("/");
            }}
          />
        </Panel>
      ) : (
        !arrived && (
          <>
            {item.callToAction !== "go" && (
              <Panel warm>
                <Copy>
                  Check the details above before leaving
                  {item.callToAction === "book"
                    ? " and confirm admission with the venue"
                    : ""}
                  . OutRN hasn’t booked anything for you.
                </Copy>
                {item.actions.websiteUrl && (
                  <ExternalButton
                    url={item.actions.websiteUrl}
                    label={
                      item.callToAction === "book"
                        ? "Check booking on website"
                        : "Check venue website"
                    }
                  />
                )}
                {item.actions.phone && (
                  <ExternalButton
                    url={item.actions.phone}
                    label="Call the venue"
                    phone
                  />
                )}
              </Panel>
            )}
            <ExternalButton
              url={item.actions.directionsUrl}
              label="Open directions"
              secondary={false}
            />
            <Button
              label="I’m here"
              secondary
              onPress={() => setOuting({ ...outing, arrived: true })}
            />
            <Copy style={[s.muted, { fontSize: 13 }]}>
              Directions open in your maps app. Arrival is marked by you; no
              location tracking.
            </Copy>
          </>
        )
      )}
      <Button
        label={arrived ? "Finish outing" : "End this plan"}
        secondary
        onPress={() => {
          setOuting(undefined);
          router.replace("/");
        }}
      />
    </Screen>
  );
}
