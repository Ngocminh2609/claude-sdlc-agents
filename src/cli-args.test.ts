import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseArgs, parseCloneArgs, resolveReferencePaths } from "./cli-args.js";

describe("parseArgs", () => {
  it("requires both --spec and --project", () => {
    expect(() => parseArgs(["--spec", "a.md"])).toThrow(/Usage/);
    expect(() => parseArgs(["--project", "/tmp/p"])).toThrow(/Usage/);
  });

  it("collects every --reference, in order", () => {
    const args = parseArgs([
      "--spec",
      "a.md",
      "--project",
      "/tmp/p",
      "--reference",
      "/tmp/sample-one",
      "--reference",
      "/tmp/sample-two",
    ]);

    expect(args.referencePaths).toEqual(["/tmp/sample-one", "/tmp/sample-two"]);
  });

  it("defaults --reference to an empty list, leaving existing runs unchanged", () => {
    expect(parseArgs(["--spec", "a.md", "--project", "/tmp/p"]).referencePaths).toEqual([]);
  });

  it("still parses the db flags", () => {
    expect(parseArgs(["--spec", "a.md", "--project", "/p", "--db-connection", "postgres://x"]).dbInfo).toEqual(
      { kind: "connection", value: "postgres://x" },
    );
    expect(parseArgs(["--spec", "a.md", "--project", "/p", "--db-schema", "s.sql"]).dbInfo).toEqual({
      kind: "schema-file",
      value: "s.sql",
    });
  });
});

describe("parseCloneArgs", () => {
  it("needs what, at least one from, and a project", () => {
    expect(() => parseCloneArgs(["--what", "X", "--from", "/a"])).toThrow(/Usage: aidev clone/);
    expect(() => parseCloneArgs(["--what", "X", "--project", "/p"])).toThrow(/Usage: aidev clone/);
    expect(() => parseCloneArgs(["--from", "/a", "--project", "/p"])).toThrow(/Usage: aidev clone/);
    expect(() => parseCloneArgs(["--what", "   ", "--from", "/a", "--project", "/p"])).toThrow();
  });

  it("collects several --from paths and trims the feature name", () => {
    const args = parseCloneArgs([
      "--what",
      "  Danh mục nghề nghiệp  ",
      "--from",
      "/tkdt/be",
      "--from",
      "/tkdt/fe",
      "--project",
      "/vimo",
    ]);

    expect(args).toEqual({
      what: "Danh mục nghề nghiệp",
      fromPaths: ["/tkdt/be", "/tkdt/fe"],
      projectPath: "/vimo",
      skipBuild: false,
    });
  });

  it("takes --no-build as a flag, not a value", () => {
    const args = parseCloneArgs(["--what", "X", "--from", "/a", "--project", "/p", "--no-build"]);
    expect(args.skipBuild).toBe(true);
  });
});

describe("resolveReferencePaths", () => {
  let root: string;
  let sample: string;
  let file: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "aidev-ref-"));
    sample = path.join(root, "sample");
    file = path.join(root, "not-a-dir.txt");
    await mkdir(sample);
    await writeFile(file, "x", "utf-8");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("resolves each directory to an absolute path", () => {
    expect(resolveReferencePaths([sample], path.join(root, "target"))).toEqual([sample]);
  });

  it("rejects a path that does not exist or is not a directory", () => {
    expect(() => resolveReferencePaths([path.join(root, "missing")], root)).toThrow(/not a directory/);
    expect(() => resolveReferencePaths([file], root)).toThrow(/not a directory/);
  });

  it("rejects the target project itself, which is already readable", () => {
    expect(() => resolveReferencePaths([sample], sample)).toThrow(/cannot be the target project/);
  });

  it("names the flag the caller actually used in the error", () => {
    expect(() => resolveReferencePaths([path.join(root, "missing")], root, "--from")).toThrow(
      /^--from is not a directory/,
    );
  });
});
