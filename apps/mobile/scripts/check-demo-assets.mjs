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
async function scan(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = resolve(path, entry.name);
    if (entry.isDirectory()) await scan(file);
    else {
      const name = photos.get(hash(await readFile(file)));
      if (name) found.add(name);
    }
  }
}
await scan(output);
if (demo ? found.size !== photos.size : found.size !== 0)
  throw new Error(
    `Unexpected demo assets in ${demo ? "demo" : "production"} export: ${[...found].join(", ") || "none"}`,
  );
console.log(
  `${demo ? "Demo" : "Production"} export: ${found.size} demo photos. Asset isolation passed.`,
);
