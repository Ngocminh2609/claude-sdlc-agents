import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasOwnBuildManifest, missingBuildManifestWarning } from "./clone-build-manifest-check.js";

describe("hasOwnBuildManifest", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "aidev-manifest-"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("is false for a directory with no recognised build manifest", async () => {
    const dir = path.join(root, "empty");
    await mkdir(dir);

    expect(hasOwnBuildManifest(dir)).toBe(false);
  });

  it.each(["package.json", "pom.xml", "build.gradle", "build.gradle.kts", "Makefile"])(
    "is true when %s is present",
    async (filename) => {
      const dir = path.join(root, `has-${filename.replace(/[^a-z0-9]/gi, "-")}`);
      await mkdir(dir);
      await writeFile(path.join(dir, filename), "", "utf-8");

      expect(hasOwnBuildManifest(dir)).toBe(true);
    },
  );

  it("is true for a dotnet project via *.csproj, regardless of filename", async () => {
    const dir = path.join(root, "dotnet-csproj");
    await mkdir(dir);
    await writeFile(path.join(dir, "MyApp.csproj"), "", "utf-8");

    expect(hasOwnBuildManifest(dir)).toBe(true);
  });

  it("is true for a dotnet solution via *.sln", async () => {
    const dir = path.join(root, "dotnet-sln");
    await mkdir(dir);
    await writeFile(path.join(dir, "MyApp.sln"), "", "utf-8");

    expect(hasOwnBuildManifest(dir)).toBe(true);
  });

  it("is false (not thrown) when the directory does not exist", () => {
    expect(hasOwnBuildManifest(path.join(root, "does-not-exist"))).toBe(false);
  });
});

describe("missingBuildManifestWarning", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "aidev-manifest-warn-"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("is null when the project has its own build manifest", async () => {
    const dir = path.join(root, "with-manifest");
    await mkdir(dir);
    await writeFile(path.join(dir, "package.json"), "{}", "utf-8");

    expect(missingBuildManifestWarning(dir)).toBeNull();
  });

  it("names the project path and suggests --no-build when there is no manifest", async () => {
    const dir = path.join(root, "without-manifest");
    await mkdir(dir);

    const warning = missingBuildManifestWarning(dir);

    expect(warning).toContain(dir);
    expect(warning).toContain("--no-build");
  });
});
