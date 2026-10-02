import { Pressable, View } from "react-native";
import { router } from "expo-router";
import { useApp } from "../state/app";
import {
  Button,
  Copy,
  Heading,
  Icon,
  IconButton,
  Loading,
  Problem,
  Row,
  Screen,
  colors,
  s,
} from "../components/ui";
import { nextPick, pickOf, setPick, type Pick } from "../lib/taste";

const SAYS: Record<Pick, string> = {
  like: "you like this",
  skip: "not for you",
  none: "no preference",
};

/**
 * Quick picks: what this person likes doing, and what isn't for them. Offered once on first open, and
 * any time from You. Kept on this device; each search sends it to rank what is open now.
 */
export default function InterestsScreen() {
  const { areas, taste, tasteHydrated, setTaste, query, search, initialize } =
    useApp();
  const close = () =>
    router.canGoBack() ? router.back() : router.replace("/");
  const finish = (refresh: boolean) => {
    setTaste({ ...taste, asked: true });
    if (refresh && query) void search(query);
    close();
  };
  const interests = areas?.filters.interests ?? [];
  const likes = interests.filter((i) => pickOf(taste, i.id) === "like").length;
  return (
    <Screen
      footer={
        <View style={{ gap: 10 }}>
          <Button
            label={likes ? "Show me what’s on" : "Done"}
            onPress={() => finish(true)}
          />
          {!taste.asked && (
            <Button label="Skip for now" secondary onPress={() => finish(false)} />
          )}
        </View>
      }
    >
      <Row style={s.between}>
        <Heading>What do you like doing?</Heading>
        <IconButton
          name="x"
          label="Close interests"
          onPress={() => finish(false)}
        />
      </Row>
      <Copy style={s.muted}>
        Tap once for what you like, twice for what isn’t for you. We’ll put
        what you like first and learn from what you go to, save or pass on.
      </Copy>
      {!tasteHydrated ? (
        <Loading label="Loading your interests…" />
      ) : !areas ? (
        <Problem
          message="The interests haven’t loaded yet."
          retry={() => void initialize()}
        />
      ) : (
        <View
          style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}
          testID="interest-picks"
        >
          {interests.map((i) => {
            const pick = pickOf(taste, i.id);
            return (
              <PickChip
                key={i.id}
                label={i.label}
                pick={pick}
                onPress={() => setTaste(setPick(taste, i.id, nextPick(pick)))}
              />
            );
          })}
        </View>
      )}
      <Row>
        <Icon name="shield" size={18} color={colors.muted} />
        <Copy style={[s.muted, { flex: 1, fontSize: 13 }]}>
          Your interests stay on this device. Each search sends them to rank
          what’s open; OutRN doesn’t keep them.
        </Copy>
      </Row>
    </Screen>
  );
}

function PickChip({
  label,
  pick,
  onPress,
}: {
  label: string;
  pick: Pick;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${SAYS[pick]}`}
      accessibilityHint="Changes between like, not for me, and no preference"
      onPress={onPress}
      style={({ pressed }) => [
        s.chip,
        pick === "like" && s.chipSelected,
        pick === "skip" && {
          backgroundColor: colors.warm,
          borderColor: colors.accent,
        },
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      <Icon
        name={pick === "like" ? "heart" : pick === "skip" ? "x" : "plus"}
        size={16}
        color={
          pick === "like"
            ? "#FFF"
            : pick === "skip"
              ? colors.accent
              : colors.muted
        }
      />
      <Copy
        style={{
          color: pick === "like" ? "#FFF" : colors.ink,
          fontWeight: "600",
          textDecorationLine: pick === "skip" ? "line-through" : "none",
        }}
      >
        {label}
      </Copy>
    </Pressable>
  );
}
