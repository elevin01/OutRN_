import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
const found = new Set();
// These are intentional interest-picker illustrations, never venue photos.
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
      const digest = hash(await readFile(file));
      const name = photos.get(digest);
      if (name) found.add(name);
      const interest = onboarding.get(digest);
      if (interest) onboardingFound.add(interest);
    }
  }
}
await scan(output);
if (onboardingFound.size !== onboarding.size)
  throw new Error(
    `Missing onboarding photos: ${[...onboarding.values()].filter((name) => !onboardingFound.has(name)).join(", ")}`,
  );
if (demo ? found.size !== photos.size : found.size !== 0)
  throw new Error(
    `Unexpected demo assets in ${demo ? "demo" : "production"} export: ${[...found].join(", ") || "none"}`,
  );
console.log(
  `${demo ? "Demo" : "Production"} export: ${found.size} demo photos, ${onboardingFound.size} onboarding illustrations. Asset isolation passed.`,
);
