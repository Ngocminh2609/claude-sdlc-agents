import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import {
  extractTags,
  indexFor,
  pruneOverlappingIndexes,
  refreshProjectIndexes,
  searchIndexes,
  SEGMENT_FILES,
  taskLocations,
} from "./project-index.js";
import { cachedStage, repoVersions } from "./stage-cache.js";

let base: string;
let repo: string;

const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: repo });

async function put(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
  await writeFile(path.join(repo, file), content, "utf-8");
}

const CONTROLLER = `package vn.x.category.controllers;
@RestController
@RequestMapping("/stats-indicator")
@Tag(name = "Stats Indicators")
public class StatsIndicatorController {
  @GetMapping("/search") public ResponseEntity<?> search() { return null; }
}`;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "aidev-index-"));
  process.env.AIDEV_INDEX_DIR = path.join(base, "index");
  process.env.AIDEV_STAGE_CACHE_DIR = path.join(base, "cache");
  // A parent folder holding a repo, like CSDL-VIMO holding BE-CSDL.
  repo = path.join(base, "project", "BE");
  await mkdir(repo, { recursive: true });
  git("init", "-q");
  await put("src/main/java/vn/x/StatsIndicatorController.java", CONTROLLER);
  await put("src/main/resources/db/stats-schema.sql", "CREATE TABLE IF NOT EXISTS stat_indicator (id uuid);");
  await put("pom.xml", "<project><artifactId>be</artifactId></project>");
  git("add", ".");
  git("commit", "-q", "-m", "init");
});

afterEach(async () => {
  delete process.env.AIDEV_INDEX_DIR;
  delete process.env.AIDEV_STAGE_CACHE_DIR;
  await rm(base, { recursive: true, force: true });
});

describe("refreshProjectIndexes", () => {
  it("finds the repos inside a parent folder and indexes every file with its key facts", async () => {
    const [indexed] = await refreshProjectIndexes([path.join(base, "project")]);

    expect(path.resolve(indexed.repoRoot)).toBe(path.resolve(repo));
    expect(indexed.rebuilt).toBe(true);
    const text = await readFile(indexed.indexFile, "utf-8");
    expect(text).toMatch(/StatsIndicatorController\.java \| controller \| .*@RestController.*tag:Stats Indicators.*GET \/stats-indicator\/search/);
    expect(text).toMatch(/stats-schema\.sql \| sql \| table:stat_indicator/);
  });

  it("re-reads nothing when nothing changed, and only what git says changed otherwise", async () => {
    await refreshProjectIndexes([repo]);

    const unchanged = (await refreshProjectIndexes([repo]))[0];
    expect(unchanged.changedFiles).toBe(0);
    expect(unchanged.rebuilt).toBe(false);

    // One uncommitted edit, one new untracked file.
    await put("src/main/java/vn/x/StatsIndicatorController.java", CONTROLLER.replace("/search", "/find"));
    await put("src/main/java/vn/x/StatsIndicatorService.java", "package vn.x;\n@Service\npublic class StatsIndicatorService {}");
    const dirty = (await refreshProjectIndexes([repo]))[0];
    expect(dirty.changedFiles).toBe(2);
    expect(await readFile(dirty.indexFile, "utf-8")).toContain("GET /stats-indicator/find");

    // Committed: the diff between the two HEADs is picked up, deletions too.
    git("rm", "-q", "src/main/resources/db/stats-schema.sql");
    git("add", ".");
    git("commit", "-q", "-m", "change");
    const committed = (await refreshProjectIndexes([repo]))[0];
    expect(await readFile(committed.indexFile, "utf-8")).not.toContain("stats-schema.sql");
    expect(committed.contentVersion).not.toBe(unchanged.contentVersion);
  });

  it("keeps the structure hash across a code edit, and changes it when a manifest or module changes", async () => {
    const before = (await refreshProjectIndexes([repo]))[0];

    await put("src/main/java/vn/x/StatsIndicatorController.java", `${CONTROLLER}\n// edited`);
    const edited = (await refreshProjectIndexes([repo]))[0];
    expect(edited.structureHash).toBe(before.structureHash);
    expect(edited.contentVersion).not.toBe(before.contentVersion);

    await put("pom.xml", "<project><artifactId>be</artifactId><modules><module>x</module></modules></project>");
    expect((await refreshProjectIndexes([repo]))[0].structureHash).not.toBe(before.structureHash);
  });

  it("counts CI/CD config and a Dockerfile as manifests too, so editing the pipeline busts the cached conventions", async () => {
    await put(".gitlab-ci.yml", "stages: [docker]\n");
    await put("Dockerfile", "FROM eclipse-temurin:25-jre-alpine\n");
    git("add", ".");
    git("commit", "-q", "-m", "add pipeline config");
    const before = (await refreshProjectIndexes([repo]))[0];

    await put(".gitlab-ci.yml", "stages: [test, docker]\n");
    expect((await refreshProjectIndexes([repo]))[0].structureHash).not.toBe(before.structureHash);

    await put(".gitlab-ci.yml", "stages: [docker]\n"); // back to the original CI content
    await put("Dockerfile", "FROM eclipse-temurin:25-jre-alpine\nCOPY modules/adapter modules/adapter\n");
    expect((await refreshProjectIndexes([repo]))[0].structureHash).not.toBe(before.structureHash);
  });
});

describe("searchIndexes", () => {
  it("matches without diacritics or case, across paths, tags and UI strings", async () => {
    await put("web/src/locales/vi-VN/chi-tieu.ts", "export default { title: 'Danh mục chỉ tiêu thống kê' };");
    const repos = await refreshProjectIndexes([repo]);

    const hits = await searchIndexes(repos, ["chi tieu thong ke", "STAT_INDICATOR"]);

    expect(hits.some((hit) => hit.includes("chi-tieu.ts") && hit.includes("Danh mục chỉ tiêu thống kê"))).toBe(true);
    expect(hits.some((hit) => hit.includes("stats-schema.sql"))).toBe(true);
  });
});

describe("extractTags", () => {
  it("reads client calls, routes and exports from a TypeScript file", () => {
    const tags = extractTags(
      "src/services/apis/stats.ts",
      "export async function search() { return request(`${apiPrefix}/stats-indicator/search`, { method: 'GET' }); }",
    );
    expect(tags).toContain("search");
    expect(tags).toContain("calls:GET ${apiPrefix}/stats-indicator/search");
  });
});

describe("stage cache over the index", () => {
  it("serves a cached answer only while the repos are unchanged", async () => {
    let calls = 0;
    const run = async () => ({ answer: ++calls });

    const first = await refreshProjectIndexes([repo]);
    const key = () => [repoVersions(first, [repo])];
    expect(indexFor(first, path.join(repo, "src"))).toBeDefined();

    expect(await cachedStage({ kind: "t", project: repo, key: key(), run })).toEqual({ answer: 1 });
    expect(await cachedStage({ kind: "t", project: repo, key: key(), run })).toEqual({ answer: 1 });
    expect(await cachedStage({ kind: "t", project: repo, key: key(), fresh: true, run })).toEqual({ answer: 2 });

    await put("src/main/java/vn/x/New.java", "class New {}");
    const changed = await refreshProjectIndexes([repo]);
    expect(await cachedStage({ kind: "t", project: repo, key: [repoVersions(changed, [repo])], run })).toEqual({ answer: 3 });
  });

  it("keeps one cache file per stage kind per project, replaced by a new answer", async () => {
    let calls = 0;
    const run = async () => ({ answer: ++calls });
    await cachedStage({ kind: "t", project: repo, key: ["v1"], run });
    await cachedStage({ kind: "t", project: repo, key: ["v2"], run });
    await cachedStage({ kind: "t", project: path.join(base, "other"), key: ["v1"], run });

    expect(readdirSync(process.env.AIDEV_STAGE_CACHE_DIR as string)).toHaveLength(2);
    expect(await cachedStage({ kind: "t", project: repo, key: ["v1"], run })).toEqual({ answer: 4 });
  });

  it("never caches what was read from a folder with no index", async () => {
    expect(repoVersions([], [repo])).toBeNull();
  });
});

describe("one index per folder", () => {
  it("indexes a folder inside a git repo on its own, without dependency or build output folders", async () => {
    await put("fe/src/App.tsx", "export function App() {}");
    // node_modules committed by mistake, a build folder simply not ignored.
    await put("fe/node_modules/lib/index.js", "export const lib = 1;");
    git("add", ".");
    git("commit", "-q", "-m", "deps");
    await put("fe/dist/bundle.js", "export const bundle = 1;");
    const [fe] = await refreshProjectIndexes([path.join(repo, "fe")]);

    expect(path.resolve(fe.repoRoot)).toBe(path.resolve(repo, "fe"));
    const text = await readFile(fe.indexFile, "utf-8");
    expect(text).toMatch(/^src\/App\.tsx \| /m);
    expect(text).not.toMatch(/node_modules|bundle\.js/);
    expect(text).not.toMatch(/StatsIndicatorController/);
  });

  it("sees only its own folder's changes in git", async () => {
    await put("fe/src/App.tsx", "export function App() {}");
    git("add", ".");
    git("commit", "-q", "-m", "fe");
    await refreshProjectIndexes([path.join(repo, "fe")]);
    await put("src/main/java/vn/x/Other.java", "class Other {}");
    const [fe] = await refreshProjectIndexes([path.join(repo, "fe")]);
    expect(fe.changedFiles).toBe(0);
  });

  it("deletes another index that covers the same code, and keeps unrelated ones", async () => {
    await put("fe/src/App.tsx", "export function App() {}");
    const other = path.join(base, "other");
    await mkdir(other, { recursive: true });
    await writeFile(path.join(other, "a.ts"), "export const a = 1;");
    await refreshProjectIndexes([repo, other]);
    expect(readdirSync(process.env.AIDEV_INDEX_DIR as string)).toHaveLength(2);

    await refreshProjectIndexes([path.join(repo, "fe")]);
    const removed = await pruneOverlappingIndexes([path.join(repo, "fe")]);

    expect(removed.map((root) => path.resolve(root))).toEqual([path.resolve(repo)]);
    expect(readdirSync(process.env.AIDEV_INDEX_DIR as string)).toHaveLength(2);
  });
});

describe("first build in segments", () => {
  it("saves each segment and finishes a stopped build from where it was", async () => {
    for (let i = 0; i < SEGMENT_FILES + 5; i++) await put(`gen/F${i}.ts`, `export const f${i} = ${i};`);
    const reported: number[] = [];
    const [built] = await refreshProjectIndexes([repo], ({ done }) => reported.push(done));
    expect(reported).toEqual([SEGMENT_FILES]);
    expect(built.fileCount).toBe(SEGMENT_FILES + 5 + 3);

    // A build stopped after its first segment: the saved partial index is finished, not redone.
    const json = path.join(path.dirname(built.indexFile), "index.json");
    const saved = JSON.parse(await readFile(json, "utf-8"));
    const kept = Object.fromEntries(Object.entries(saved.files).slice(0, 10));
    await writeFile(json, JSON.stringify({ ...saved, partial: true, files: kept }), "utf-8");
    const resumed: number[] = [];
    const [finished] = await refreshProjectIndexes([repo], ({ done }) => resumed.push(done));
    // 1,998 files left fit in one segment; redoing all 2,008 would have reported a saved segment.
    expect(resumed).toEqual([]);
    expect(finished.fileCount).toBe(SEGMENT_FILES + 5 + 3);
    expect(JSON.parse(await readFile(json, "utf-8")).partial).toBeUndefined();
  }, 60_000);
});

describe("taskLocations", () => {
  it("gives each expected file's index line, marks new ones, and adds lines for named identifiers", async () => {
    const repos = await refreshProjectIndexes([repo]);
    const lines = await taskLocations(
      repos,
      ["BE/src/main/java/vn/x/StatsIndicatorController.java", "BE/src/main/java/vn/x/RevenueController.java"],
      "Add a revenue endpoint next to `stat_indicator` reads; keep the existing service untouched.",
    );
    expect(lines[0]).toMatch(/^BE\/src\/main\/java\/vn\/x\/StatsIndicatorController\.java \| controller/);
    expect(lines[1]).toBe("BE/src/main/java/vn/x/RevenueController.java | new file (not in the index)");
    expect(lines.some((line) => /stats-schema\.sql \| sql/.test(line))).toBe(true);
  });
});
