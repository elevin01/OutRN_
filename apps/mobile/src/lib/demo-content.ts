import type { ImageSourcePropType } from "react-native";

// This entire module is required only behind an inline EXPO_PUBLIC_DEMO_MODE check.
// These are illustrative category photos and fictional posts, never venue evidence.
export type DemoPost = {
  id: string;
  name: string;
  age: string;
  text: string;
  tip: string;
  saves: number;
  photo: ImageSourcePropType;
};
export type DemoContent = {
  photos: ImageSourcePropType[];
  posts: DemoPost[];
  reviews: { name: string; text: string }[];
};
const cafe = require("../../assets/photos/cafe.jpg");
const coffee = require("../../assets/photos/coffee.jpg");
const pastry = require("../../assets/photos/pastry.jpg");
const culture = require("../../assets/photos/culture.jpg");

export function getDemoContent(category: string): DemoContent | undefined {
  if (["cafe", "restaurant", "bakery"].includes(category))
    return {
      photos: [cafe, coffee, pastry],
      posts: [
        {
          id: "window",
          name: "Maya",
          age: "2h ago",
          text: "Found a seat by the window. Coffee, a warm pastry, and no rush.",
          tip: "Try the almond croissant",
          saves: 38,
          photo: pastry,
        },
        {
          id: "coffee",
          name: "Jordan",
          age: "45m ago",
          text: "Stopped in for a flat white. The corner table is a good spot to catch up.",
          tip: "The flat white",
          saves: 21,
          photo: coffee,
        },
      ],
      reviews: [
        {
          name: "Alex",
          text: "Easy place to catch up. A few tables were full when we visited; we waited about ten minutes.",
        },
        {
          name: "Sam",
          text: "The pastry was my favourite part. I’d come back for that and a coffee.",
        },
      ],
    };
  if (["museum", "gallery", "arts_centre"].includes(category))
    return {
      photos: [culture],
      posts: [
        {
          id: "art",
          name: "Nico",
          age: "3h ago",
          text: "Spent most of my visit with this one. Give yourself a moment to look closely.",
          tip: "Ask about the current exhibition",
          saves: 16,
          photo: culture,
        },
      ],
      reviews: [
        {
          name: "Lee",
          text: "A quiet visit, with a few pieces I kept coming back to. Check admission before heading over.",
        },
      ],
    };
  return undefined;
}
