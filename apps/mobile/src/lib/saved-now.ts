import type {
  RecommendationItem,
  RecommendationRequest,
  RecommendationResponse,
  RecommendationsBody,
} from "@outrn/contracts";

export type SavedMatch = {
  item: RecommendationItem;
  response: RecommendationResponse;
};
export type SavedMatches = {
  matches: Record<string, SavedMatch>;
  response: RecommendationResponse;
};

/** Only the API determines fitness. Traverse its frozen pages without replacing the Now deck. */
export async function loadSavedMatches(
  query: RecommendationRequest,
  placeIds: string[],
  recommend: (
    body: RecommendationsBody,
    signal?: AbortSignal,
  ) => Promise<RecommendationResponse>,
  signal: AbortSignal,
): Promise<SavedMatches> {
  const request = { ...query };
  // This control is explicitly for now; other time, travel, budget and party settings stay intact.
  delete request.at;
  const wanted = new Set(placeIds);
  const matches: Record<string, SavedMatch> = {};
  const first = await recommend(request, signal);
  let page = first;
  const cursors = new Set<string>();
  while (!signal.aborted) {
    for (const item of page.items) {
      // An event at a saved venue is not a feasibility check for visiting that venue itself.
      if (
        item.kind === "venue" &&
        item.status === "ready" &&
        wanted.has(item.placeId) &&
        !matches[item.placeId]
      )
        matches[item.placeId] = { item, response: page };
    }
    const cursor = page.page.nextCursor;
    if (!cursor || Object.keys(matches).length === wanted.size)
      return { matches, response: first };
    if (cursors.has(cursor))
      throw new Error("Saved places couldn’t be checked. Please try again.");
    cursors.add(cursor);
    const next = await recommend({ cursor }, signal);
    if (
      next.requestId !== first.requestId ||
      next.page.offset <= page.page.offset
    )
      throw new Error("This search changed. Please check again.");
    page = next;
  }
  throw new Error("Search cancelled");
}
