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
      target: { project: "/vimo" },
      from: { paths: ["/tkdt/be", "/tkdt/fe"] },
      skipBuild: false,
      skipTests: false,
      fresh: false,
    });
  });

  it("reads --no-tests", () => {
    const args = parseCloneArgs(["--what", "x", "--from", "/a", "--project", "/b", "--no-tests"]);
    expect(args.skipTests).toBe(true);
  });

  it("takes separate BE/FE sources and targets", () => {
    const args = parseCloneArgs([
      "--what",
      "nghề nghiệp",
      "--from-be",
      "/tkdt/be",
      "--from-fe",
      "/tkdt/fe",
      "--project-be",
      "/vimo/be",
      "--project-fe",
      "/vimo/fe",
    ]);

    expect(args.from).toEqual({ paths: [], be: "/tkdt/be", fe: "/tkdt/fe" });
    expect(args.target).toEqual({ be: "/vimo/be", fe: "/vimo/fe" });
  });

  it("accepts a BE-only or FE-only source and target", () => {
    expect(parseCloneArgs(["--what", "X", "--from-fe", "/a", "--project-fe", "/p"]).target).toEqual({ fe: "/p" });
  });

  it("refuses --project together with --project-be/--project-fe", () => {
    expect(() =>
      parseCloneArgs(["--what", "X", "--from", "/a", "--project", "/p", "--project-be", "/b"]),
    ).toThrow(/either --project or --project-be/);
  });

  it("takes --no-build as a flag, not a value", () => {
    const args = parseCloneArgs(["--what", "X", "--from", "/a", "--project", "/p", "--no-build"]);
    expect(args.skipBuild).toBe(true);
  });

  it("takes --fresh as a flag", () => {
    expect(parseCloneArgs(["--what", "X", "--from", "/a", "--project", "/p", "--fresh"]).fresh).toBe(true);
  });
});

describe("separate BE/FE folders on a feature run", () => {
  it("takes --project-be and --project-fe instead of --project", () => {
    expect(parseArgs(["--spec", "a.md", "--project-be", "/be", "--project-fe", "/fe"]).target).toEqual({
      be: "/be",
      fe: "/fe",
    });
  });

  it("still needs some target folder", () => {
    expect(() => parseArgs(["--spec", "a.md"])).toThrow(/Usage/);
  });

  it("refuses to mix --project with --project-be/--project-fe", () => {
    expect(() => parseArgs(["--spec", "a.md", "--project", "/p", "--project-fe", "/fe"])).toThrow(
      /either --project or --project-be/,
    );
  });
});

describe("--fresh on a feature run", () => {
  it("defaults to resuming, and --fresh turns it off", () => {
    expect(parseArgs(["--spec", "a.md", "--project", "/p"]).fresh).toBe(false);
    expect(parseArgs(["--spec", "a.md", "--project", "/p", "--fresh"]).fresh).toBe(true);
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
    expect(() => resolveReferencePaths([sample], sample)).toThrow(/cannot be a target project folder/);
  });

  it("names the flag the caller actually used in the error", () => {
    expect(() => resolveReferencePaths([path.join(root, "missing")], root, "--from")).toThrow(
      /^--from is not a directory/,
    );
  });
});
