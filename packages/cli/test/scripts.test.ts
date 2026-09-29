import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * scripts/real.sh (pnpm real) and scripts/capture-live.sh (pnpm capture) on their failure paths, with
 * no database and no network. Each run gets a scratch repo root (with a space in its path) holding
 * copies of the two scripts, sample captures in fixtures/live, and stub `pnpm` and `psql` commands
 * first on PATH (test/stubs) that log what they are asked and fail on request.
 *
 * OUTRN_TEST_BASH32=/path/to/bash-3.2 runs every case under that shell too (macOS's default bash).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const BASH32 = process.env["OUTRN_TEST_BASH32"];
const SHELLS = BASH32 ? ["bash", BASH32] : ["bash"];
const LOCAL_DB = "postgres://outrn@127.0.0.1:54329/outrn_real";

let root: string;
const live = (name: string) => join(root, "fixtures", "live", name);
const put = (name: string, content: string) => writeFileSync(live(name), content);
const bytes = (name: string) => readFileSync(live(name));
const staging = () => readdirSync(join(root, "fixtures", "live")).filter((n) => n.startsWith(".staging"));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "outrn scripts "));
  mkdirSync(join(root, "scripts"));
  for (const s of ["real.sh", "capture-live.sh"]) copyFileSync(join(REPO, "scripts", s), join(root, "scripts", s));
  mkdirSync(join(root, "fixtures", "live"), { recursive: true });
  mkdirSync(join(root, "bin"));
  for (const s of ["pnpm", "psql"]) {
    copyFileSync(join(HERE, "stubs", `${s}.sh`), join(root, "bin", s));
    chmodSync(join(root, "bin", s), 0o755);
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(shell: string, script: "real.sh" | "capture-live.sh", args: string[], env: Record<string, string>) {
  const logFile = join(root, "stub.log");
  const r = spawnSync(shell, [join(root, "scripts", script), ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
    env: {
      PATH: `${join(root, "bin")}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
      HOME: root,
      TMPDIR: tmpdir(),
      LC_ALL: "C",
      STUB_LOG: logFile,
      STUB_AREAS: "les bronxville",
      ...env,
    },
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  return { status: r.status, out, log, pnpmCalls: log.split("\n").filter((l) => l.startsWith("pnpm ")) };
}

describe.each(SHELLS)("pnpm real (%s)", (shell) => {
  const real = (env: Record<string, string> = {}) => run(shell, "real.sh", [], env);
  beforeEach(() => {
    put("les.json", '{"elements":[]}');
    put("bronxville.json", '{"elements":[]}');
  });

  it("refuses REAL_DATABASE_URL without printing it or touching any database", () => {
    const r = real({ REAL_DATABASE_URL: "postgres://admin:hunter2-secret@prod.example.com:5432/app" });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/REAL_DATABASE_URL is no longer supported/);
    expect(r.out).not.toContain("hunter2-secret");
    expect(r.out).not.toContain("prod.example.com");
    expect(r.log).not.toMatch(/db:reset|db:migrate|drop database|create database/);
    expect(r.out).not.toContain("API STARTED");
  });

  it("serves every capture, only ever on the local outrn_real, and prints no secret from the environment", () => {
    put("les-photos.json", '{"requests":{}}');
    const secrets = { PGPASSWORD: "pg-secret-1", DATABASE_URL: "postgres://outrn:url-secret-2@db.example.com/prod", OUTRN_OPS_TOKEN: "ops-secret-3" };
    const r = real({ ...secrets, STUB_PHOTOS: "1" });
    expect(r.status, r.out).toBe(0);
    for (const s of ["pg-secret-1", "url-secret-2", "db.example.com", "ops-secret-3"]) expect(r.out).not.toContain(s);
    expect(r.out).toMatch(/Serving bronxville les on http:\/\/127\.0\.0\.1:4000/);
    expect(r.out).toContain("API STARTED");
    expect(r.out).toMatch(/photos +3 for/);
    // Every command that reached a database reached the local outrn_real, whatever DATABASE_URL said.
    for (const call of r.pnpmCalls) expect(call).toContain(`DATABASE_URL=${LOCAL_DB}`);
    expect(r.log.match(/drop database[^|]*/g)).toEqual(["drop database if exists outrn_real -c create database outrn_real "]);
    expect(r.log).toMatch(/ingest photos --area les --from-file fixtures\/live\/les-photos\.json/);
  });

  it("fetches the served areas' weather after switching them on", () => {
    const r = real();
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/== weather\n +les: 156 hours/);
    const calls = r.pnpmCalls.map((c) => c.split(" | ")[0]);
    expect(calls.indexOf("pnpm -s outrn weather refresh")).toBeGreaterThan(calls.findLastIndex((c) => c.includes("areas launch")));
    expect(r.out).toContain("API STARTED");
  });

  it("says so when the weather can't be fetched, and serves the areas without it", () => {
    const r = real({ STUB_FAIL_WEATHER: "1" });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/not refreshed: plans ignore the weather/);
    expect(r.out).toMatch(/could not resolve api\.weather\.gov/);
    expect(r.out).toMatch(/Serving bronxville les on/);
    expect(r.out).toContain("API STARTED");
  });

  it("fetches no weather when no area is served", () => {
    const r = real({ STUB_NO_VENUES: "les bronxville" });
    expect(r.status, r.out).toBe(0);
    expect(r.log).not.toMatch(/weather refresh/);
    expect(r.out).toMatch(/Serving no areas/);
  });

  it("stops before serving anything when a saved photo capture fails to replay", () => {
    put("les-photos.json", '{"requests":{}}');
    const r = real({ STUB_PHOTOS: "1", STUB_FAIL_PHOTOS: "les" });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/les: fixtures\/live\/les-photos\.json did not replay/);
    expect(r.out).not.toContain("Serving");
    expect(r.out).not.toContain("API STARTED");
    expect(r.log).not.toMatch(/areas launch les/);
  });

  it("replays an area's Overture capture after its places, never as an area of its own", () => {
    put("les-overture.json", '{"outrn_capture":"overture"}');
    const r = real();
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/claims +4 operating/);
    expect(r.log).toMatch(/ingest overture --area les --from-file fixtures\/live\/les-overture\.json/);
    expect(r.log).not.toMatch(/slug=les-overture/);
    expect(r.out).toMatch(/Serving bronxville les on/);
  });

  it("stops before serving anything when a saved Overture capture fails to replay", () => {
    put("les-overture.json", "not json");
    const r = real();
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/les: fixtures\/live\/les-overture\.json did not replay/);
    expect(r.out).not.toContain("Serving");
    expect(r.out).not.toContain("API STARTED");
  });

  it("stops before serving anything when the capture of a real area is corrupt", () => {
    put("bronxville.json", "<html>502 Bad Gateway</html>");
    const r = real();
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/bronxville: fixtures\/live\/bronxville\.json did not replay/);
    expect(r.out).not.toMatch(/not an area/);
    expect(r.out).not.toContain("Serving");
    expect(r.out).not.toContain("API STARTED");
  });

  it("stops before serving anything when an ingest, the migrations or a launch fail", () => {
    for (const env of [{ STUB_FAIL_OSM: "les" }, { STUB_MIGRATE_EXIT: "1" }, { STUB_FAIL_LAUNCH: "bronxville" }]) {
      const r = real(env);
      expect(r.status, JSON.stringify(env)).not.toBe(0);
      expect(r.out).not.toContain("Serving");
      expect(r.out).not.toContain("API STARTED");
    }
  });

  it("serves the rest when an area has no eligible venues", () => {
    const r = real({ STUB_NO_VENUES: "bronxville" });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/not served: no eligible venues/);
    expect(r.out).toMatch(/Serving les on/);
    expect(r.out).toContain("API STARTED");
  });

  it("skips a capture named after something that is not an area, without ingesting it, and serves the rest", () => {
    put("zzz_nowhere.json", '{"elements":[]}');
    put("zzz_nowhere-photos.json", '{"requests":{}}');
    const r = real({ STUB_PHOTOS: "1" });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/skipped: zzz_nowhere is not an area here/);
    expect(r.log).not.toMatch(/--area zzz_nowhere/);
    expect(r.log).toMatch(/-v slug=zzz_nowhere .*stdin=select count\(\*\) from service_areas where slug = :'slug';/);
    expect(r.out).toMatch(/Serving bronxville les on/);
    expect(r.out).toContain("API STARTED");
  });
});

describe.each(SHELLS)("pnpm capture (%s)", (shell) => {
  const capture = (args: string[], env: Record<string, string> = {}) => run(shell, "capture-live.sh", args, { OUTRN_USER_AGENT: "outrn-test", CAPTURE_PAUSE_SECONDS: "0", STUB_PHOTOS: "1", ...env });
  const OLD_OSM = Buffer.from('{"osm":"old les"}\n');
  const OLD_PHOTOS = Buffer.from('{"photos":"old les"}\n');
  const OLD_OVERTURE = Buffer.from('{"outrn_capture":"overture","area":"old les"}\n');
  const unchanged = () => bytes("les.json").equals(OLD_OSM) && bytes("les-photos.json").equals(OLD_PHOTOS) && bytes("les-overture.json").equals(OLD_OVERTURE);
  beforeEach(() => {
    writeFileSync(live("les.json"), OLD_OSM);
    writeFileSync(live("les-photos.json"), OLD_PHOTOS);
    writeFileSync(live("les-overture.json"), OLD_OVERTURE);
  });

  it("keeps the previous pair byte for byte when the places step writes its capture and then fails", () => {
    const r = capture(["les"], { STUB_FAIL_OSM: "les" });
    expect(r.status).not.toBe(0);
    expect(unchanged()).toBe(true);
    expect(r.log).not.toMatch(/ingest overture/);
    // The stub did write its capture: into the staging directory, which is gone.
    expect(r.log).toMatch(/ingest osm --area les --save .*\/fixtures\/live\/\.staging\.[^/]+\/les\.json/);
    expect(staging()).toEqual([]);
    expect(r.out).toMatch(/Failed: les \(places\)\. Run them again: pnpm capture les/);
  });

  it("keeps the previous pair byte for byte when the photos step fails after the places step succeeded", () => {
    const r = capture(["les"], { STUB_FAIL_PHOTOS: "les" });
    expect(r.status).not.toBe(0);
    expect(unchanged()).toBe(true);
    expect(staging()).toEqual([]);
    expect(r.out).toMatch(/Failed: les \(photos\)/);
  });

  it("keeps the previous set byte for byte when the Overture step writes its capture and then fails", () => {
    const r = capture(["les"], { STUB_FAIL_OVERTURE: "les" });
    expect(r.status).not.toBe(0);
    expect(unchanged()).toBe(true);
    expect(r.log).toMatch(/ingest overture --area les --save .*\/fixtures\/live\/\.staging\.[^/]+\/les-overture\.json/);
    expect(staging()).toEqual([]);
    expect(r.out).toMatch(/Failed: les \(overture\)/);
  });

  it("replaces all three files when every step succeeded, and only for the areas that did", () => {
    const r = capture(["les", "bronxville"], { STUB_FAIL_OSM: "bronxville" });
    expect(r.status).not.toBe(0);
    expect(bytes("les.json").toString()).toBe('{"osm":"new les"}');
    expect(bytes("les-photos.json").toString()).toBe('{"photos":"new les"}');
    expect(bytes("les-overture.json").toString()).toBe('{"outrn_capture":"overture","area":"new les"}');
    expect(existsSync(live("bronxville.json"))).toBe(false);
    expect(existsSync(live("bronxville-overture.json"))).toBe(false);
    expect(existsSync(live("bronxville-photos.json"))).toBe(false);
    expect(staging()).toEqual([]);
    expect(r.out).toMatch(/Run them again: pnpm capture bronxville$/m);

    const ok = capture(["les"]);
    expect(ok.status, ok.out).toBe(0);
    expect(ok.out).toContain("Done.");
  });

  it("without a photos command, replaces the places capture only and says the photos are older", () => {
    const r = capture(["les"], { STUB_PHOTOS: "" });
    expect(r.status, r.out).toBe(0);
    expect(bytes("les.json").toString()).toBe('{"osm":"new les"}');
    expect(bytes("les-photos.json").equals(OLD_PHOTOS)).toBe(true);
    expect(bytes("les-overture.json").toString()).toBe('{"outrn_capture":"overture","area":"new les"}');
    expect(r.out).toMatch(/note: fixtures\/live\/les-photos\.json is from an earlier capture/);
    expect(r.log).not.toMatch(/ingest photos --area/);
  });

  it("with no arguments, captures every area the database lists", () => {
    const r = capture([], { STUB_AREAS: "bronxville les yonkers" });
    expect(r.status, r.out).toBe(0);
    const areas = [...r.log.matchAll(/ingest osm --area (\S+) --save/g)].map((m) => m[1]);
    expect(areas).toEqual(["bronxville", "les", "yonkers"]);
    for (const a of ["bronxville", "les", "yonkers"]) expect(bytes(`${a}.json`).toString()).toBe(`{"osm":"new ${a}"}`);
    expect(staging()).toEqual([]);
  });

  it("with no arguments and no areas, says so instead of tripping over an empty list", () => {
    const r = capture([], { STUB_AREAS: "" });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/No service areas in outrn_capture: nothing to capture/);
    expect(r.out).not.toMatch(/unbound variable/);
    expect(r.log).not.toMatch(/ingest osm/);
  });
});

describe("the scripts use nothing newer than Bash 3.2 (macOS's default)", () => {
  // Constructs newer than Bash 3.2, looked for in the code (comments stripped).
  const BASH4: [string, RegExp][] = [
    ["mapfile / readarray", /\b(mapfile|readarray)\b/],
    ["associative arrays or namerefs", /\b(declare|typeset|local)\s+-[a-zA-Z]*[An]/],
    ["case modification ${x,,} ${x^^}", /\$\{[#!]?[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?(\^|,)/],
    ["|& pipes", /\|&/],
    ["&>> redirection", /&>>/],
    ["coproc", /\bcoproc\b/],
    ["globstar", /\bglobstar\b/],
    ["negative array index", /\$\{[A-Za-z_][A-Za-z0-9_]*\[\s*-\s*[0-9]/],
    ["negative substring length", /\$\{[A-Za-z_][A-Za-z0-9_]*:[^}:]*:\s*-[0-9]/],
    ["case fall-through ;& ;;&", /;;&|(^|[^;]);&/m],
    ["${x@Q} transformations", /\$\{[^}]*@[QEPAaKkUuL]\}/],
    ["[[ -v ]] / test -v", /(\[\[?|\btest)\s+-v\b/],
    ["wait -n", /\bwait\s+-n\b/],
    ["brace expansion with a step", /\{[^{}\s]+\.\.[^{}\s]+\.\.[^{}\s]+\}/],
    ["printf %(...)T", /%\([^)]*\)T/],
    ["shopt options newer than 3.2", /\bshopt\s+-[su]\s+(lastpipe|inherit_errexit|globasciiranges|autocd|checkjobs|direxpand|dirspell|localvar_inherit|assoc_expand_once)/],
    ["$BASHPID / $EPOCHSECONDS", /\$\{?(BASHPID|EPOCHSECONDS|EPOCHREALTIME|SRANDOM)\b/],
  ];

  it.each(["real.sh", "capture-live.sh"])("%s uses no Bash 4 construct", (script) => {
    const code = readFileSync(join(REPO, "scripts", script), "utf8")
      .split("\n")
      .map((line) => line.replace(/(^|\s)#.*$/, ""))
      .join("\n");
    const found = BASH4.filter(([, re]) => re.test(code)).map(([name]) => name);
    expect(found).toEqual([]);
  });
});
