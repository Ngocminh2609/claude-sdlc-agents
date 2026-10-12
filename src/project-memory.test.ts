import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadProjectMemory,
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
  it("reuses conventions only while the build manifests are the ones they were read under", async () => {
    const key = manifestKeyOf([index(roots[0], "m1"), index(roots[1], "m2")], roots);
    expect(key).not.toBeNull();
    await rememberConventions(roots, key as string, "Spring Boot modules under com.app.*");

    const memory = await loadProjectMemory(roots);
    expect(reusableConventions(memory, key)).toBe("Spring Boot modules under com.app.*");
    const changed = manifestKeyOf([index(roots[0], "m1-new"), index(roots[1], "m2")], roots);
    expect(reusableConventions(memory, changed)).toBeNull();
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
