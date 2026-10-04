import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Checks an export for what it must and must not contain.
 *  - The demo module (invented posts and reviews) ships only when EXPO_PUBLIC_DEMO_MODE=true: its
 *    text is looked for in every emitted script.
 *  - The representative photos ship in every build: they stand in, labelled, for places without a
 *    photo of their own (src/lib/representative.ts).
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.argv[2] || resolve(root, "dist"));
const demo =
  process.argv.includes("--demo") ||
  process.env.EXPO_PUBLIC_DEMO_MODE === "true";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const photos = new Map(
  await Promise.all(
    ["cafe.jpg", "culture.jpg", "coffee.jpg", "pastry.jpg"].map(
      async (name) => [
        hash(await readFile(resolve(root, "assets/photos", name))),
        name,
      ],
    ),
  ),
);
/** Text that exists only in src/lib/demo-content.ts. */
const DEMO_MARKERS = [
  "Found a seat by the window",
  "Spent most of my visit with this one",
];
const foundPhotos = new Set();
const foundMarkers = new Set();
// Interest illustrations are separate from photographs of a recommendation.
const onboarding = new Map(
  await Promise.all(
    ["food", "coffee", "walk", "pub", "art", "music", "games", "market"].map(
      async (name) => [
        hash(await readFile(resolve(root, "assets/onboarding", `${name}.jpg`))),
        name,
      ],
    ),
  ),
);
const onboardingFound = new Set();
async function scan(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = resolve(path, entry.name);
    if (entry.isDirectory()) await scan(file);
    else {
      const bytes = await readFile(file);
      const digest = hash(bytes);
      const name = photos.get(digest);
      if (name) foundPhotos.add(name);
      const interest = onboarding.get(digest);
      if (interest) onboardingFound.add(interest);
      if (/\.(js|mjs|cjs|hbc|bundle|html)$/.test(entry.name)) {
        const text = bytes.toString("latin1");
        for (const m of DEMO_MARKERS) if (text.includes(m)) foundMarkers.add(m);
      }
    }
  }
}
await scan(output);
const problems = [];
if (onboardingFound.size !== onboarding.size)
  problems.push(
    `onboarding illustrations missing: ${[...onboarding.values()].filter((name) => !onboardingFound.has(name)).join(", ")}`,
  );
if (foundPhotos.size !== photos.size)
  problems.push(
    `representative photos missing: ${[...photos.values()].filter((n) => !foundPhotos.has(n)).join(", ")}`,
  );
if (demo && foundMarkers.size === 0)
  problems.push("the demo export has no demo content");
if (!demo && foundMarkers.size > 0)
  problems.push(
    `the production export contains demo content: ${[...foundMarkers].join(" / ")}`,
  );
if (problems.length)
  throw new Error(
    `${demo ? "Demo" : "Production"} export: ${problems.join("; ")}`,
  );
console.log(
  `${demo ? "Demo" : "Production"} export: ${foundPhotos.size} representative photos, ${onboardingFound.size} onboarding illustrations, ${foundMarkers.size ? "demo content included" : "no demo content"}. Asset check passed.`,
);
