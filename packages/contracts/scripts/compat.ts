/**
 * CI: fail when schema/v1.json changed in a way that breaks clients built against the base branch.
 *
 *   tsx scripts/compat.ts <base v1.json> [head v1.json]
 *
 * Set ALLOW_BREAKING=1 (the PR carries the `contract-breaking` label) to report without failing.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareContracts } from "./compat-lib.js";

const [basePath, headArg] = process.argv.slice(2);
const headPath = headArg ?? resolve(dirname(fileURLToPath(import.meta.url)), "../schema/v1.json");
if (!basePath || !existsSync(basePath) || readFileSync(basePath, "utf8").trim() === "") {
  console.log("no base contract to compare with (new contract): nothing can break");
  process.exit(0);
}
const findings = compareContracts(JSON.parse(readFileSync(basePath, "utf8")), JSON.parse(readFileSync(headPath, "utf8")));
if (!findings.length) {
  console.log("contract change is backward compatible");
  process.exit(0);
}
console.log(`${findings.length} breaking contract change(s):`);
for (const f of findings) console.log(`  ${f.path}: ${f.message}`);
if (process.env["ALLOW_BREAKING"] === "1") {
  console.log("\nALLOW_BREAKING=1 (label contract-breaking): reported, not failing. Coordinate the UI change in the same release.");
  process.exit(0);
}
console.log("\nAdditive changes are free; breaking ones need the UI updated in step. If this is intended, add the `contract-breaking` label to the PR.");
process.exit(1);
