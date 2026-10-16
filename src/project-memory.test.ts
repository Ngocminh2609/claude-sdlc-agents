import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  e2eRecipePromptSection,
  loadProjectMemory,
  rememberE2eRecipe,
  manifestKeyOf,
  projectMemoryPromptSection,
  rememberConventions,
  rememberFeatureStatus,
  rememberTask,
  reusableConventions,
  specIdentity,
} from "./project-memory.js";
import type { ProjectRoot } from "./target-roots.js";

const roots: ProjectRoot[] = [
  { role: "be", path: path.resolve("/tmp/app/BE") },
  { role: "fe", path: path.resolve("/tmp/app/FE") },
];
const index = (root: ProjectRoot, manifestHash: string) => ({
  repoRoot: root.path,
  indexFile: "",
  indexDir: "",
  structureHash: "s",
  contentVersion: "c",
  manifestHash,
});

let base: string;

beforeEach(async () => {
  // Never the real runs/: it holds every checkpoint and the run history.
  base = await mkdtemp(path.join(tmpdir(), "aidev-memory-"));
  process.env.AIDEV_MEMORY_DIR = base;
});

afterEach(async () => {
  delete process.env.AIDEV_MEMORY_DIR;
  await rm(base, { recursive: true, force: true });
});

describe("project memory", () => {
  it("keeps the latest E2E start-up recipe and hands it to the next E2E prompt", async () => {
    expect(e2eRecipePromptSection(await loadProjectMemory(roots))).toEqual([]);
    await rememberE2eRecipe(roots, "old recipe");
    await rememberE2eRecipe(roots, "FE: playwright.config.ts starts vite on E2E_PORT; BE: java -jar app.jar");

    const section = e2eRecipePromptSection(await loadProjectMemory(roots)).join("\n");
    expect(section).toContain("How the last passing E2E run started this app");
    expect(section).toContain("playwright.config.ts starts vite");
    expect(section).not.toContain("old recipe");
  });

  it("saves no E2E recipe for an empty answer", async () => {
    await rememberE2eRecipe(roots, "   ");
    expect((await loadProjectMemory(roots)).e2e).toBeUndefined();
  });
  it("reuses conventions only while the build manifests are the ones they were read under", async () => {
    const key = manifestKeyOf([index(roots[0], "m1"), index(roots[1], "m2")], roots);
    expect(key).not.toBeNull();
    const verifyCommands = [{ folder: roots[0].path, command: "mvn -q compile" }];
    await rememberConventions(roots, key as string, "Spring Boot modules under com.app.*", verifyCommands);

    const memory = await loadProjectMemory(roots);
    expect(reusableConventions(memory, key)).toEqual({ text: "Spring Boot modules under com.app.*", verifyCommands });
    const changed = manifestKeyOf([index(roots[0], "m1-new"), index(roots[1], "m2")], roots);
    expect(reusableConventions(memory, changed)).toBeNull();
  });

  it("does not reuse conventions saved before the build check had commands to keep", async () => {
    const key = manifestKeyOf([index(roots[0], "m1"), index(roots[1], "m2")], roots) as string;
    await rememberConventions(roots, key, "Spring Boot modules under com.app.*");

    expect(reusableConventions(await loadProjectMemory(roots), key)).toBeNull();
  });

  it("has no key, so reuses nothing, when a target folder is not indexed", () => {
    expect(manifestKeyOf([index(roots[0], "m1")], roots)).toBeNull();
  });

  it("records each finished task under its spec and lists them for the next run", async () => {
    const spec = specIdentity("# Dashboard phòng\n\nbody");
    await rememberTask(roots, spec, { id: "T1", summary: "Added GET /api/rooms. More detail here.", files: ["BE/RoomController.java"] });
    await rememberTask(roots, spec, { id: "T2", summary: "Room table on /dashboard." });
    await rememberFeatureStatus(roots, spec, "done");

    const memory = await loadProjectMemory(roots);
    expect(memory.features).toHaveLength(1);
    expect(memory.features[0]).toMatchObject({ title: "Dashboard phòng", status: "done" });
    const section = projectMemoryPromptSection(memory).join("\n");
    expect(section).toContain("Dashboard phòng");
    expect(section).toContain("T1: Added GET /api/rooms. [BE/RoomController.java]");
    expect(section).not.toContain("More detail here");
  });

  it("writes a readable map next to the data, for a person or an agent to skim", async () => {
    await rememberTask(roots, specIdentity("# Login"), { id: "T1", summary: "Login endpoint." });

    const files = (await import("node:fs")).readdirSync(base);
    const markdown = await readFile(path.join(base, files.find((file) => file.endsWith(".md")) as string), "utf-8");
    expect(markdown).toContain("# Project map");
    expect(markdown).toContain("### Login");
  });

  it("does not create a feature just to record a status", async () => {
    await rememberFeatureStatus(roots, specIdentity("# Never coded"), "escalated-specs");

    expect((await loadProjectMemory(roots)).features).toEqual([]);
  });

  it("refuses to write the real map from a unit test", async () => {
    delete process.env.AIDEV_MEMORY_DIR;

    await expect(rememberTask(roots, specIdentity("# X"), { id: "T1", summary: "s" })).rejects.toThrow(/AIDEV_MEMORY_DIR/);
  });
});
