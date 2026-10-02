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
async function scan(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = resolve(path, entry.name);
    if (entry.isDirectory()) await scan(file);
    else {
      const bytes = await readFile(file);
      const name = photos.get(hash(bytes));
      if (name) foundPhotos.add(name);
      if (/\.(js|mjs|cjs|hbc|bundle|html)$/.test(entry.name)) {
        const text = bytes.toString("latin1");
        for (const m of DEMO_MARKERS) if (text.includes(m)) foundMarkers.add(m);
      }
    }
  }
}
await scan(output);
const problems = [];
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
  `${demo ? "Demo" : "Production"} export: ${foundPhotos.size} representative photos, ${foundMarkers.size ? "demo content included" : "no demo content"}. Asset check passed.`,
);
