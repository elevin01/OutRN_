#!/usr/bin/env node
/**
 * Keeps the UI/backend split honest (CI runs this; `pnpm check:boundaries` locally).
 *
 *  1. packages/web and apps/mobile may depend on and import only @outrn/contracts from the workspace — never the
 *     engine, db, ingestion or api packages, and never files outside their UI package by relative path.
 *  2. packages/contracts depends on zod only and imports nothing else, so it stays browser-safe.
 *  3. The mock API imports only the contract, its fixtures and Hono, so it runs without a database.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const SOURCE = /\.(m?[jt]sx?|cjs)$/;
const SKIP = new Set(["node_modules", ".next", "dist", "dist-review", ".expo"]);
const SPECIFIER = /(?:import|export)\s[^'"`;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (SOURCE.test(name) && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

function imports(file) {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(SPECIFIER)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]);
}

function checkPackageDeps(pkgDir, allowed, what) {
  const pkg = JSON.parse(readFileSync(join(ROOT, pkgDir, "package.json"), "utf8"));
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const dep of Object.keys(pkg[field] ?? {})) if (!allowed(dep)) problems.push(`${pkgDir}/package.json: ${field} "${dep}" — ${what}`);
  }
}

// 1. The UI reaches the backend only through the contract.
for (const ui of ["packages/web", "apps/mobile"]) {
  const WEB = join(ROOT, ui);
  checkPackageDeps(ui, (d) => !d.startsWith("@outrn/") || d === "@outrn/contracts", "the UI may depend on @outrn/contracts only");
  for (const file of files(WEB)) {
    for (const spec of imports(file)) {
      const rel = relative(ROOT, file);
      if (spec.startsWith("@outrn/") && !/^@outrn\/contracts(\/|$)/.test(spec)) problems.push(`${rel}: imports "${spec}" — use the API client (lib/api.ts) and @outrn/contracts`);
      if (spec.startsWith(".")) {
        const target = resolve(dirname(file), spec);
        if (!(target + sep).startsWith(WEB + sep)) problems.push(`${rel}: imports "${spec}", outside ${ui}`);
      }
    }
  }
}

// 2. The contract is self-contained.
checkPackageDeps("packages/contracts", (d) => d === "zod" || d === "tsx", "the contract may depend on zod only");
for (const file of files(join(ROOT, "packages/contracts/src"))) {
  if (file.endsWith(".test.ts")) continue;
  for (const spec of imports(file)) if (!spec.startsWith(".") && spec !== "zod/v4") problems.push(`${relative(ROOT, file)}: imports "${spec}" — the contract imports zod/v4 and its own files only`);
}

// 3. The mock needs no database.
for (const file of files(join(ROOT, "packages/api/src/mock"))) {
  if (file.endsWith(".test.ts")) continue;
  for (const spec of imports(file)) {
    const ok = spec.startsWith(".") ? resolve(dirname(file), spec).startsWith(join(ROOT, "packages/api/src/mock")) : /^(@outrn\/contracts(\/fixtures)?|hono(\/.*)?|zod\/v4)$/.test(spec);
    if (!ok) problems.push(`${relative(ROOT, file)}: imports "${spec}" — the mock may use only the contract, fixtures and hono`);
  }
}

if (problems.length) {
  console.error(`Boundary check failed (${problems.length}):\n${problems.map((p) => `  ${p}`).join("\n")}`);
  process.exit(1);
}
console.log("boundaries ok: web + mobile → @outrn/contracts only; contracts → zod only; mock → no database");
