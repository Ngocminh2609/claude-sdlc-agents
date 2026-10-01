import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractTags, indexFor, refreshProjectIndexes, searchIndexes } from "./project-index.js";
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

    expect(await cachedStage({ kind: "t", key: key(), run })).toEqual({ answer: 1 });
    expect(await cachedStage({ kind: "t", key: key(), run })).toEqual({ answer: 1 });
    expect(await cachedStage({ kind: "t", key: key(), fresh: true, run })).toEqual({ answer: 2 });

    await put("src/main/java/vn/x/New.java", "class New {}");
    const changed = await refreshProjectIndexes([repo]);
    expect(await cachedStage({ kind: "t", key: [repoVersions(changed, [repo])], run })).toEqual({ answer: 3 });
  });

  it("never caches what was read from a folder with no index", async () => {
    expect(repoVersions([], [repo])).toBeNull();
  });
});
