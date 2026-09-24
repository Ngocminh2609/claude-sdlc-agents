import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const execFile = vi.fn();
const readFile = vi.fn();
const writeFile = vi.fn();
const mkdir = vi.fn();

vi.mock("node:child_process", () => ({ execFile }));
vi.mock("node:fs/promises", () => ({ readFile, writeFile, mkdir }));

const { getCachedTargetConventions, storeTargetConventions } = await import("./target-conventions-cache.js");

function mockGitHead(head: string | null) {
  execFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback: (...a: unknown[]) => void) => {
    if (head === null) callback(new Error("not a git repo"));
    else callback(null, { stdout: `${head}\n`, stderr: "" });
  });
}

beforeEach(() => {
  execFile.mockReset();
  readFile.mockReset();
  writeFile.mockReset();
  mkdir.mockReset();
  mkdir.mockResolvedValue(undefined);
  writeFile.mockResolvedValue(undefined);
});

describe("getCachedTargetConventions", () => {
  it("misses when the project is not a git repo", async () => {
    mockGitHead(null);

    const result = await getCachedTargetConventions("/tmp/project");

    expect(result).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("misses when there is no cache file yet", async () => {
    mockGitHead("abc123");
    readFile.mockRejectedValue(new Error("ENOENT"));

    expect(await getCachedTargetConventions("/tmp/project")).toBeNull();
  });

  it("misses when the cached entry's git head no longer matches (project changed)", async () => {
    mockGitHead("new-head");
    readFile.mockResolvedValue(
      JSON.stringify({
        [path.resolve("/tmp/project")]: {
          gitHead: "old-head",
          conventions: { summary: "stale" },
        },
      }),
    );

    expect(await getCachedTargetConventions("/tmp/project")).toBeNull();
  });

  it("hits when the cached entry's git head matches", async () => {
    mockGitHead("abc123");
    readFile.mockResolvedValue(
      JSON.stringify({
        [path.resolve("/tmp/project")]: {
          gitHead: "abc123",
          conventions: { summary: "modules/ layout" },
        },
      }),
    );

    const result = await getCachedTargetConventions("/tmp/project");

    expect(result?.summary).toBe("modules/ layout");
  });
});

describe("storeTargetConventions", () => {
  it("does nothing when the project is not a git repo", async () => {
    mockGitHead(null);

    await storeTargetConventions("/tmp/project", { summary: "x" });

    expect(writeFile).not.toHaveBeenCalled();
  });

  it("writes the conventions keyed by the resolved project path and current git head", async () => {
    mockGitHead("abc123");
    readFile.mockRejectedValue(new Error("ENOENT"));

    await storeTargetConventions("/tmp/project", { summary: "modules/ layout" });

    expect(writeFile).toHaveBeenCalledTimes(1);
    const [, contents] = writeFile.mock.calls[0];
    const written = JSON.parse(contents as string);
    const key = path.resolve("/tmp/project");
    expect(written[key]).toEqual({ gitHead: "abc123", conventions: { summary: "modules/ layout" } });
  });

  it("preserves other projects' cached entries when adding one", async () => {
    mockGitHead("abc123");
    const otherKey = path.resolve("/tmp/other-project");
    readFile.mockResolvedValue(
      JSON.stringify({ [otherKey]: { gitHead: "zzz", conventions: { summary: "other" } } }),
    );

    await storeTargetConventions("/tmp/project", { summary: "modules/ layout" });

    const [, contents] = writeFile.mock.calls[0];
    const written = JSON.parse(contents as string);
    expect(written[otherKey]).toEqual({ gitHead: "zzz", conventions: { summary: "other" } });
  });
});
