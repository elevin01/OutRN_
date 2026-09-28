import { useState } from "react";
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import type { DemoContent, DemoPost } from "../lib/demo-content";
import { Copy, Icon, colors } from "./ui";
import { Sheet } from "./Sheet";

export function Community({ demo }: { demo?: DemoContent }) {
  const [sort, setSort] = useState("Popular");
  const [post, setPost] = useState<DemoPost>();
  const { width } = useWindowDimensions();
  const posts =
    sort === "Recent" ? [...(demo?.posts || [])].reverse() : demo?.posts || [];
  return (
    <View style={styles.section}>
      <Copy accessibilityRole="header" style={styles.heading}>
        What’s poppin’
      </Copy>
      <Copy style={styles.sub}>
        {demo
          ? "Example posts and reviews · fictional people"
          : "Posts and reviews aren’t available yet."}
      </Copy>
      {demo ? (
        <>
          <View style={styles.sort}>
            {["Popular", "Recent", "Reviews"].map((label) => (
              <Pressable
                key={label}
                accessibilityRole="button"
                accessibilityState={{ selected: sort === label }}
                onPress={() => setSort(label)}
                style={[styles.pill, sort === label && styles.selected]}
              >
                <Copy
                  style={[
                    styles.label,
                    sort === label && { color: colors.paper },
                  ]}
                >
                  {label}
                </Copy>
              </Pressable>
            ))}
          </View>
          {sort === "Reviews" ? (
            demo.reviews.map((review) => (
              <View key={review.name} style={styles.review}>
                <Copy style={styles.name}>
                  {review.name}
                  <Copy style={styles.caption}> · Example review</Copy>
                </Copy>
                <Copy>{review.text}</Copy>
              </View>
            ))
          ) : (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.posts}
            >
              {posts.map((p) => (
                <Pressable
                  key={p.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Read ${p.name}’s example post`}
                  onPress={() => setPost(p)}
                  style={{ width: Math.min(241, width - 64), gap: 10 }}
                >
                  <Image
                    source={p.photo}
                    style={styles.photo}
                    accessibilityLabel="Illustrative photo, not this venue"
                  />
                  <View style={styles.creator}>
                    <View style={styles.avatar}>
                      <Copy style={styles.label}>{p.name[0]}</Copy>
                    </View>
                    <Copy style={styles.name}>{p.name}</Copy>
                    <Copy style={styles.caption}>{p.age}</Copy>
                  </View>
                  <Copy>{p.text}</Copy>
                  <View style={styles.tip}>
                    <Icon
                      name="corner-down-right"
                      size={15}
                      color={colors.green}
                    />
                    <Copy style={styles.label}>{p.tip}</Copy>
                  </View>
                  <Copy style={styles.caption}>
                    {p.saves} saves · Example post
                  </Copy>
                </Pressable>
              ))}
            </ScrollView>
          )}
        </>
      ) : (
        <View style={styles.empty}>
          <Icon name="message-circle" color={colors.green} />
          <Copy style={styles.sub}>
            Check the venue’s website for the latest updates.
          </Copy>
        </View>
      )}
      <Sheet
        visible={!!post}
        title={post ? `${post.name}’s post` : "Post"}
        close={() => setPost(undefined)}
      >
        {post && (
          <>
            <Image source={post.photo} style={styles.photo} />
            <Copy>{post.text}</Copy>
            <Copy style={styles.name}>{post.tip}</Copy>
            <Copy style={styles.caption}>
              Illustrative community content. This is not a real person’s post
              or a report about this venue.
            </Copy>
          </>
        )}
      </Sheet>
    </View>
  );
}
const styles = StyleSheet.create({
  section: {
    padding: 24,
    gap: 14,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  heading: {
    fontSize: 20,
    lineHeight: 26,
    fontWeight: "600",
    letterSpacing: -0.4,
  },
  sub: { fontSize: 13, lineHeight: 20, color: colors.muted },
  caption: { fontSize: 12, lineHeight: 18, color: colors.muted },
  sort: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  pill: {
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 24,
    backgroundColor: "#EBEDE5",
  },
  selected: { backgroundColor: colors.ink },
  label: { fontSize: 13, lineHeight: 19, fontWeight: "500" },
  posts: { gap: 14, paddingBottom: 8 },
  photo: { width: "100%", height: 194, borderRadius: 18 },
  creator: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
  },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.sage,
  },
  name: { fontSize: 13, lineHeight: 19, fontWeight: "600" },
  tip: { flexDirection: "row", gap: 6, alignItems: "center" },
  review: {
    paddingVertical: 14,
    gap: 10,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  empty: {
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
    paddingVertical: 12,
  },
});
