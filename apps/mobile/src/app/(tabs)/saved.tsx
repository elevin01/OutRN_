import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FlatList,
  Pressable,
  TextInput,
  View,
  useWindowDimensions,
  type ViewToken,
} from "react-native";
import { router, useFocusEffect } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useApp } from "../../state/app";
import { useSavedDetails } from "../../state/saved-details";
import { api, demoMode } from "../../lib/api";
import {
  actionLabel,
  ageLabel,
  duration,
  isExpired,
  priceLabel,
  travelLabel,
} from "../../lib/presentation";
import { loadSavedMatches, type SavedMatches } from "../../lib/saved-now";
import {
  MAX_COLLECTIONS,
  type RemovedSave,
  type SavedCollection,
  type SavedPlace,
} from "../../lib/saved-library";
import {
  Button,
  Chip,
  Copy,
  Icon,
  Loading,
  colors,
  type IconName,
} from "../../components/ui";
import { RequiredNotes } from "../../components/PlaceCard";
import { SavedMedia } from "../../components/SavedMedia";
import { Sheet } from "../../components/Sheet";
import { styles } from "../../components/saved-styles";

type Entry = { id: string; places: SavedPlace[]; collection?: SavedCollection };
type Editor = SavedCollection & { existing: boolean };

export default function SavedScreen() {
  const {
    saved,
    collections,
    hydrated,
    storageError,
    retrySaved,
    toggleSaved,
    restoreSaved,
    saveCollection,
    deleteCollection,
    query,
    areas,
    setSavedPlan,
  } = useApp();
  const [tab, setTab] = useState<"places" | "collections">("places");
  const [collectionId, setCollectionId] = useState<string>();
  const collection = collections.find((c) => c.id === collectionId);
  const [fits, setFits] = useState(false);
  const [searching, setSearching] = useState(false);
  const [text, setText] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState<"recent" | "name">("recent");
  const [sheet, setSheet] = useState<
    "filters" | "place" | "add" | "edit" | "delete"
  >();
  const [active, setActive] = useState<SavedPlace>();
  const [editor, setEditor] = useState<Editor>();
  const [removed, setRemoved] = useState<RemovedSave>();
  const [refresh, setRefresh] = useState(0);
  const [focused, setFocused] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const { details, failed } = useSavedDetails(visibleIds, refresh, focused);
  const [fitState, setFitState] = useState<{
    key: string;
    data?: SavedMatches;
    error?: string;
  }>();
  const fitKey = JSON.stringify([query, saved.map((p) => p.id), refresh]);
  const requestKey = JSON.stringify(query);
  const savedKey = JSON.stringify(saved.map((p) => p.id));
  const fitData = fitState?.key === fitKey ? fitState.data : undefined;
  const fitError = fitState?.key === fitKey ? fitState.error : undefined;
  const expired = !!fitData && !demoMode && isExpired(fitData.response, now);
  const { width, fontScale } = useWindowDimensions();
  const columns = fontScale > 1.5 ? 1 : 2;
  const tileWidth = (Math.min(width, 600) - 40 - (columns - 1) * 13) / columns;
  const collectionView = tab === "collections" && !collection;
  const categoryLabel = (id: string) =>
    areas?.filters.categories.find((c) => c.id === id)?.label ||
    id.replace(/_/g, " ");

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      setNow(Date.now());
      return () => setFocused(false);
    }, []),
  );
  useEffect(() => {
    if (!focused) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [focused]);
  useEffect(() => {
    if (!fitData || demoMode) return;
    const delay = new Date(fitData.response.expiresAt).getTime() - Date.now();
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Math.min(delay, 2_147_483_647)),
    );
    return () => clearTimeout(timer);
  }, [fitData]);
  useEffect(() => {
    if (!fits || !focused || !requestKey || savedKey === "[]") return;
    const controller = new AbortController();
    const key = JSON.stringify([
      JSON.parse(requestKey),
      JSON.parse(savedKey),
      refresh,
    ]);
    void loadSavedMatches(
      JSON.parse(requestKey),
      JSON.parse(savedKey),
      api.recommend,
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) {
          setNow(Date.now());
          setFitState({ key, data });
        }
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted)
          setFitState({ key, error: error.message });
      });
    return () => controller.abort();
  }, [fits, focused, requestKey, savedKey, refresh]);

  const matches = (p: SavedPlace, ignoreText = false) =>
    (!category || p.category === category) &&
    (ignoreText ||
      !text.trim() ||
      `${p.name} ${categoryLabel(p.category)}`
        .toLocaleLowerCase()
        .includes(text.trim().toLocaleLowerCase())) &&
    (!fits || (!expired && !!fitData?.matches[p.id]));
  const matching = saved.filter((p) => matches(p));
  if (sort === "name") matching.sort((a, b) => a.name.localeCompare(b.name));
  const entries: Entry[] = collectionView
    ? collections
        .map((c) => ({
          id: c.id,
          collection: c,
          places: saved.filter(
            (p) =>
              c.placeIds.includes(p.id) &&
              matches(
                p,
                !!text.trim() &&
                  c.name
                    .toLocaleLowerCase()
                    .includes(text.trim().toLocaleLowerCase()),
              ),
          ),
        }))
        .filter(
          (e) =>
            (!fits && !category && !text.trim()) ||
            e.places.length > 0 ||
            (!fits &&
              !category &&
              !!text.trim() &&
              e
                .collection!.name.toLocaleLowerCase()
                .includes(text.trim().toLocaleLowerCase())),
        )
    : matching
        .filter((p) => !collection || collection.placeIds.includes(p.id))
        .map((p) => ({ id: p.id, places: [p] }));
  const fitPending =
    fits && saved.length > 0 && !!query && !fitData && !fitError;
  const blocked = fits && (!query || fitPending || !!fitError || expired);
  const viewable = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken<Entry>[] }) => {
      const ids = [
        ...new Set(
          viewableItems.flatMap((v) =>
            v.item.places.slice(0, 2).map((p) => p.id),
          ),
        ),
      ].sort();
      setVisibleIds((old) =>
        JSON.stringify(old) === JSON.stringify(ids) ? old : ids,
      );
    },
    [setVisibleIds],
  );
  const viewConfig = useMemo(() => ({ itemVisiblePercentThreshold: 1 }), []);
  const open = (place: SavedPlace) => {
    const match = fits ? fitData?.matches[place.id] : undefined;
    const current =
      match && (demoMode || !isExpired(match.response)) ? match : undefined;
    setSavedPlan(current);
    router.push({
      pathname: "/place/[id]",
      params: {
        id: place.id,
        ...(current ? { itemId: current.item.id, source: "saved" } : {}),
      },
    });
  };
  const beginCollection = (existing?: SavedCollection) => {
    setEditor(
      existing
        ? { ...existing, existing: true }
        : {
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
            name: "",
            placeIds: active && sheet === "add" ? [active.id] : [],
            existing: false,
          },
    );
    setSheet("edit");
  };
  const chooseTab = (next: "places" | "collections") => {
    setTab(next);
    setCollectionId(undefined);
    setText("");
    setSearching(false);
    setCategory("");
    setSort("recent");
  };
  const clear = () => {
    setText("");
    setCategory("");
    setFits(false);
  };
  const credits = [
    ...new Set([
      ...Object.values(details).flatMap((p) => p.attributions),
      ...(fits && fitData ? fitData.response.attributions : []),
    ]),
  ];

  const header = (
    <View style={styles.header}>
      {demoMode && (
        <Copy style={styles.demo}>
          DEMO · Invented places and fixed example times
        </Copy>
      )}
      {collection && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to collections"
          onPress={() => setCollectionId(undefined)}
          style={styles.back}
        >
          <Icon name="chevron-left" size={18} />
          <Copy style={styles.small}>Collections</Copy>
        </Pressable>
      )}
      <View style={styles.titleRow}>
        <Copy accessibilityRole="header" style={styles.title}>
          {collection?.name || "Saved"}
        </Copy>
        <View style={styles.actions}>
          <Action
            name="search"
            label="Search saved places"
            onPress={() => {
              setSearching((v) => !v);
              setText("");
            }}
          />
          {collection ? (
            <Action
              name="more-horizontal"
              label="Edit collection"
              onPress={() => beginCollection(collection)}
            />
          ) : collectionView ? (
            <Action
              name="plus"
              label="Create collection"
              onPress={() => beginCollection()}
              disabled={!hydrated || collections.length >= MAX_COLLECTIONS}
            />
          ) : (
            <Action
              name="sliders"
              label="Filter and sort saved places"
              onPress={() => setSheet("filters")}
            />
          )}
        </View>
      </View>
      {searching && (
        <View style={styles.search}>
          <Icon name="search" size={18} />
          <TextInput
            autoFocus
            accessibilityLabel="Search saved places"
            placeholder="Find a saved place"
            placeholderTextColor={colors.muted}
            value={text}
            onChangeText={setText}
            style={styles.input}
            returnKeyType="search"
          />
          <Action
            name="x"
            label="Close search"
            onPress={() => {
              setText("");
              setSearching(false);
            }}
          />
        </View>
      )}
      {!!saved.length && (
        <View style={styles.tabs}>
          {!collection && (
            <>
              <Pressable
                accessibilityRole="tab"
                accessibilityState={{ selected: tab === "places" }}
                onPress={() => chooseTab("places")}
                style={[styles.tab, tab === "places" && styles.selectedTab]}
              >
                <Copy style={styles.tabText}>All saved</Copy>
              </Pressable>
              <Pressable
                accessibilityRole="tab"
                accessibilityState={{ selected: tab === "collections" }}
                onPress={() => chooseTab("collections")}
                style={[
                  styles.tab,
                  tab === "collections" && styles.selectedTab,
                ]}
              >
                <Copy style={styles.tabText}>Collections</Copy>
              </Pressable>
            </>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Fits now"
            accessibilityState={{ selected: fits }}
            onPress={() => setFits((v) => !v)}
            style={[styles.fits, fits && styles.fitsSelected]}
          >
            <Icon
              name={fits ? "check" : "sun"}
              size={14}
              color={fits ? colors.paper : colors.ink}
            />
            <Copy style={[styles.fitsText, fits && { color: colors.paper }]}>
              Fits now
            </Copy>
          </Pressable>
        </View>
      )}
      {storageError && (
        <View style={styles.notice}>
          <Copy accessibilityRole="alert">{storageError}</Copy>
          <TextAction label="Try saving again" onPress={retrySaved} />
        </View>
      )}
      {fits && fitData && !expired && (
        <Copy style={styles.context}>
          {fitData.response.area.name} ·{" "}
          {duration(fitData.response.request.windowMinutes)} ·{" "}
          {fitData.response.request.travelMode}
          {fitData.response.request.originIsDefault ? " from area center" : ""}
        </Copy>
      )}
      {(category || (!fits && sort === "name")) && (
        <TextAction
          label={`${category ? categoryLabel(category) + " · " : ""}${sort === "name" ? "Name A–Z" : "Recently saved"}`}
          onPress={() => setSheet("filters")}
        />
      )}
    </View>
  );
  const empty = !hydrated ? (
    storageError ? null : (
      <Loading label="Loading your saves…" />
    )
  ) : !saved.length ? (
    <Empty
      title="Keep a good thing."
      copy="Save a place that catches your eye. It’ll be here when you’re ready."
      action="Find something good"
      onPress={() => router.navigate("/")}
    />
  ) : blocked ? (
    fitPending ? (
      <Loading label="Checking your saved places…" />
    ) : (
      <Empty
        title={expired ? "Time for a fresh look." : "Couldn’t check right now."}
        copy={
          fitError ||
          (expired
            ? "These plans have expired. Your places are still saved."
            : "Choose your area and plans to check your saves.")
        }
        action={!query ? "Set your plans" : "Check again"}
        onPress={() =>
          !query ? router.push("/filters") : setRefresh((r) => r + 1)
        }
        secondary="See all saved"
        onSecondary={clear}
      />
    )
  ) : !entries.length ? (
    collectionView && !collections.length ? (
      <Empty
        title="Make a little collection."
        copy="Keep your after-work spots or weekend ideas together."
        action="Create collection"
        onPress={() => beginCollection()}
      />
    ) : collection && !collection.placeIds.length ? (
      <Empty
        title="Room for a good find."
        copy="Add a few of your saved places to this collection."
        action="Add places"
        onPress={() => beginCollection(collection)}
      />
    ) : (
      <Empty
        title={fits ? "Another time, then." : "No matches yet."}
        copy={
          fits
            ? "None of these saves were confirmed ready for your current plans. Your places are still here."
            : "Try another name or clear your filters."
        }
        action={fits ? "See all saved" : "Clear filters"}
        onPress={clear}
      />
    )
  ) : null;

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.root}>
      <FlatList<Entry>
        key={`${collectionView ? "collections" : "places"}-${columns}-${collectionId || "home"}`}
        data={blocked || !hydrated ? [] : entries}
        keyExtractor={(entry) => entry.id}
        numColumns={collectionView ? 1 : columns}
        columnWrapperStyle={
          !collectionView && columns > 1 ? styles.columns : undefined
        }
        contentContainerStyle={styles.content}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        keyboardShouldPersistTaps="handled"
        refreshing={fitPending}
        onRefresh={() => setRefresh((r) => r + 1)}
        onViewableItemsChanged={viewable}
        viewabilityConfig={viewConfig}
        initialNumToRender={6}
        windowSize={5}
        ListFooterComponent={
          credits.length ? (
            <Copy style={styles.credits}>{credits.join(" · ")}</Copy>
          ) : null
        }
        renderItem={({ item: entry }) =>
          entry.collection ? (
            <View style={styles.collectionCard}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open collection ${entry.collection.name}, ${entry.places.length} places`}
                onPress={() => {
                  setCollectionId(entry.id);
                  setText("");
                }}
              >
                <View style={styles.covers}>
                  {entry.places.length ? (
                    entry.places.slice(0, 2).map((p, i) => (
                      <View key={p.id} style={{ flex: i === 0 ? 1.45 : 1 }}>
                        <SavedMedia
                          name={p.name}
                          category={p.category}
                          categoryLabel={
                            details[p.id]?.category.label ||
                            categoryLabel(p.category)
                          }
                          photos={details[p.id]?.photos}
                          height={165}
                        />
                      </View>
                    ))
                  ) : (
                    <View style={styles.emptyCover}>
                      <Icon name="folder" size={32} color={colors.green} />
                    </View>
                  )}
                </View>
                <View style={styles.collectionCaption}>
                  <Copy style={styles.collectionName}>
                    {entry.collection.name}
                  </Copy>
                  <Copy style={styles.small}>
                    {entry.places.length}{" "}
                    {entry.places.length === 1 ? "place" : "places"}
                  </Copy>
                  <Icon name="chevron-right" size={16} color={colors.muted} />
                </View>
              </Pressable>
            </View>
          ) : (
            (() => {
              const place = entry.places[0];
              const detail = details[place.id];
              const match =
                fits && !expired ? fitData?.matches[place.id]?.item : undefined;
              const fresh =
                detail &&
                !failed.has(place.id) &&
                (demoMode ||
                  (now - Date.parse(detail.asOf) < 60_000 &&
                    Date.parse(detail.asOf) <= now + 60_000));
              const hours =
                detail?.status === "closed_permanently"
                  ? "Permanently closed"
                  : detail?.status === "closed_temporarily"
                    ? "Temporarily closed"
                    : fresh
                      ? detail.hoursNow.summary || "Hours unconfirmed"
                      : failed.has(place.id)
                        ? "Details unavailable"
                        : detail
                          ? "Refresh for latest hours"
                          : "Checking details…";
              const menu = () => {
                setActive(place);
                setSheet("place");
              };
              return (
                <View style={[styles.tile, { width: tileWidth }]}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${place.name}`}
                    accessibilityHint="Long press for saved place options"
                    onPress={() => open(place)}
                    onLongPress={menu}
                    accessibilityActions={[
                      { name: "longpress", label: "Saved place options" },
                    ]}
                    onAccessibilityAction={({ nativeEvent }) => {
                      if (nativeEvent.actionName === "longpress") menu();
                    }}
                  >
                    <SavedMedia
                      name={place.name}
                      category={place.category}
                      categoryLabel={
                        detail?.category.label || categoryLabel(place.category)
                      }
                      photos={
                        detail?.photos.length ? detail.photos : match?.photos
                      }
                      height={width < 360 ? 110 : 124}
                    />
                    <Copy style={styles.category}>
                      {detail?.category.label || categoryLabel(place.category)}
                      {match?.price || detail?.price
                        ? ` · ${priceLabel((match?.price || detail?.price)!)}`
                        : ""}
                    </Copy>
                    <Copy style={styles.placeName}>
                      {detail?.name || place.name}
                    </Copy>
                    {match && (
                      <Copy style={styles.small}>{travelLabel(match)}</Copy>
                    )}
                    <Copy
                      style={[
                        styles.status,
                        fresh &&
                          ["open", "always_open"].includes(
                            detail.hoursNow.state,
                          ) &&
                          styles.open,
                      ]}
                    >
                      {hours}
                    </Copy>
                    {match ? (
                      <>
                        <Copy style={styles.ready}>{actionLabel(match)}</Copy>
                        <RequiredNotes item={match} />
                      </>
                    ) : detail?.ageLimit ? (
                      <Copy style={styles.age}>
                        {ageLabel(detail.ageLimit)}
                      </Copy>
                    ) : null}
                  </Pressable>
                </View>
              );
            })()
          )
        }
      />
      {removed && (
        <View style={styles.toast} accessibilityLiveRegion="polite">
          <Copy style={styles.toastText}>Removed from Saved</Copy>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              restoreSaved(removed);
              setRemoved(undefined);
            }}
            style={styles.undo}
          >
            <Copy style={styles.toastText}>Undo</Copy>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss undo"
            onPress={() => setRemoved(undefined)}
            style={styles.dismiss}
          >
            <Icon name="x" size={16} color={colors.paper} />
          </Pressable>
        </View>
      )}
      <Sheet
        visible={!!sheet}
        title={
          sheet === "filters"
            ? "Sort & filter"
            : sheet === "edit"
              ? editor?.existing
                ? "Edit collection"
                : "New collection"
              : sheet === "delete"
                ? "Delete collection?"
                : sheet === "add"
                  ? "Add to collection"
                  : active?.name || "Saved place"
        }
        close={() => setSheet(undefined)}
      >
        {sheet === "filters" && (
          <>
            <Copy style={styles.label}>Sort by</Copy>
            <View style={styles.chips}>
              <Chip
                label="Recently saved"
                selected={sort === "recent"}
                onPress={() => setSort("recent")}
              />
              <Chip
                label="Name A–Z"
                selected={sort === "name"}
                onPress={() => setSort("name")}
              />
            </View>
            <Copy style={styles.label}>Kind of place</Copy>
            <View style={styles.chips}>
              <Chip
                label="All"
                selected={!category}
                onPress={() => setCategory("")}
              />
              {[...new Set(saved.map((p) => p.category))].map((id) => (
                <Chip
                  key={id}
                  label={categoryLabel(id)}
                  selected={category === id}
                  onPress={() => setCategory(id)}
                />
              ))}
            </View>
            <Button
              label="Show saved places"
              onPress={() => setSheet(undefined)}
            />
          </>
        )}
        {sheet === "place" && active && (
          <>
            <Button
              label="Add to collection"
              onPress={() => setSheet("add")}
              secondary
            />
            <Button
              label="Remove from Saved"
              onPress={() => {
                setRemoved({
                  place: active,
                  index: saved.findIndex((p) => p.id === active.id),
                  collectionIds: collections
                    .filter((c) => c.placeIds.includes(active.id))
                    .map((c) => c.id),
                });
                toggleSaved(active);
                setSheet(undefined);
              }}
              secondary
            />
          </>
        )}
        {sheet === "add" && active && (
          <>
            {collections.map((c) => (
              <Chip
                key={c.id}
                label={c.name}
                selected={c.placeIds.includes(active.id)}
                onPress={() =>
                  saveCollection({
                    ...c,
                    placeIds: c.placeIds.includes(active.id)
                      ? c.placeIds.filter((id) => id !== active.id)
                      : [...c.placeIds, active.id],
                  })
                }
              />
            ))}
            <Button
              label="New collection"
              disabled={collections.length >= MAX_COLLECTIONS}
              onPress={() => beginCollection()}
              secondary
            />
            <Button label="Done" onPress={() => setSheet(undefined)} />
          </>
        )}
        {sheet === "edit" && editor && (
          <>
            <TextInput
              accessibilityLabel="Collection name"
              placeholder="e.g. After work"
              placeholderTextColor={colors.muted}
              value={editor.name}
              maxLength={40}
              onChangeText={(name) => setEditor({ ...editor, name })}
              style={styles.nameInput}
              returnKeyType="done"
            />
            <Copy style={styles.label}>Your saved places</Copy>
            {saved.map((p) => (
              <Pressable
                key={p.id}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: editor.placeIds.includes(p.id) }}
                onPress={() =>
                  setEditor({
                    ...editor,
                    placeIds: editor.placeIds.includes(p.id)
                      ? editor.placeIds.filter((id) => id !== p.id)
                      : [...editor.placeIds, p.id],
                  })
                }
                style={styles.checkRow}
              >
                <Copy>{p.name}</Copy>
                <Icon
                  name={
                    editor.placeIds.includes(p.id) ? "check-square" : "square"
                  }
                  size={22}
                  color={colors.green}
                />
              </Pressable>
            ))}
            <Button
              label={editor.existing ? "Save collection" : "Create collection"}
              disabled={
                !editor.name.trim() ||
                (!editor.existing && collections.length >= MAX_COLLECTIONS)
              }
              onPress={() => {
                saveCollection(editor);
                setSheet(undefined);
                setCollectionId(undefined);
                setTab("collections");
              }}
            />
            {editor.existing && (
              <TextAction
                label="Delete collection"
                onPress={() => setSheet("delete")}
              />
            )}
          </>
        )}
        {sheet === "delete" && editor && (
          <>
            <Copy>Your places will stay in All saved.</Copy>
            <Button
              label="Delete collection"
              onPress={() => {
                deleteCollection(editor.id);
                setCollectionId(undefined);
                setSheet(undefined);
              }}
            />
            <Button
              label="Keep collection"
              onPress={() => setSheet("edit")}
              secondary
            />
          </>
        )}
      </Sheet>
    </SafeAreaView>
  );
}

function Action({
  name,
  label,
  onPress,
  disabled,
}: {
  name: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        { opacity: disabled ? 0.4 : pressed ? 0.6 : 1 },
      ]}
    >
      <Icon name={name} size={20} />
    </Pressable>
  );
}
function TextAction({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={styles.textAction}
    >
      <Copy style={styles.link}>{label}</Copy>
    </Pressable>
  );
}
function Empty({
  title,
  copy,
  action,
  onPress,
  secondary,
  onSecondary,
}: {
  title: string;
  copy: string;
  action: string;
  onPress: () => void;
  secondary?: string;
  onSecondary?: () => void;
}) {
  return (
    <View style={styles.empty}>
      <Copy accessibilityRole="header" style={styles.emptyTitle}>
        {title}
      </Copy>
      <Copy style={styles.emptyCopy}>{copy}</Copy>
      <Button label={action} onPress={onPress} />
      {secondary && onSecondary && (
        <TextAction label={secondary} onPress={onSecondary} />
      )}
    </View>
  );
}
