import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runsDir } from "./paths.js";

const readdir = vi.fn();
const stat = vi.fn();
const rm = vi.fn();
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal()),
  readdir,
  stat,
  rm,
}));

const { clearRuns, deleteRun, isValidRunId, RunNotFoundError, specNameFromRunId } = await import("./runs.js");

beforeEach(() => {
  readdir.mockReset();
  stat.mockReset();
  rm.mockReset();
});

describe("isValidRunId", () => {
  it("accepts the folder names RunLogger produces", () => {
    expect(isValidRunId("2026-09-08T05-34-52-193Z-CSDL-VIMO-spec-danh-muc-don-vi-tinh")).toBe(true);
  });

  it("rejects anything that could walk out of runs/", () => {
    for (const id of ["", "..", "../../etc/passwd", "a/b", "a\\b", ".hidden", "x".repeat(201)]) {
      expect(isValidRunId(id)).toBe(false);
    }
  });
});

describe("specNameFromRunId", () => {
  it("recovers the spec slug from the id and the logged project path", () => {
    expect(
      specNameFromRunId("2026-09-08T05-34-52-193Z-CSDL-VIMO-spec-units", "D:\\Source_Code\\CSDL-VIMO"),
    ).toBe("spec-units");
    expect(specNameFromRunId("2026-01-01T00-00-00-000Z-app-my-feature", "/home/me/app")).toBe(
      "my-feature",
    );
  });

  it("gives up rather than guessing when the pieces do not line up", () => {
    expect(specNameFromRunId("2026-09-08T05-34-52-193Z-app-spec", null)).toBeNull();
    expect(specNameFromRunId("no-timestamp-here", "/home/me/other")).toBeNull();
  });
});

describe("deleteRun", () => {
  it("rejects an invalid id without touching the filesystem", async () => {
    await expect(deleteRun("../../etc/passwd")).rejects.toThrow(RunNotFoundError);
    expect(stat).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
  });

  it("rejects an id that does not exist under runs/", async () => {
    stat.mockRejectedValue(new Error("ENOENT"));

    await expect(deleteRun("2026-01-01T00-00-00-000Z-app-spec")).rejects.toThrow(RunNotFoundError);
    expect(rm).not.toHaveBeenCalled();
  });

  it("removes the run's own folder, recursively", async () => {
    stat.mockResolvedValue({ isDirectory: () => true });
    rm.mockResolvedValue(undefined);

    await deleteRun("2026-01-01T00-00-00-000Z-app-spec");

    expect(rm).toHaveBeenCalledWith(
      path.join(runsDir, "2026-01-01T00-00-00-000Z-app-spec"),
      { recursive: true, force: true },
    );
  });
});

describe("clearRuns", () => {
  it("returns 0 when there is no runs/ folder yet", async () => {
    readdir.mockRejectedValue(new Error("ENOENT"));

    expect(await clearRuns()).toBe(0);
    expect(rm).not.toHaveBeenCalled();
  });

  it("removes every run folder and counts how many", async () => {
    readdir.mockResolvedValue([
      { name: "2026-01-01T00-00-00-000Z-app-a", isDirectory: () => true },
      { name: "2026-01-02T00-00-00-000Z-app-b", isDirectory: () => true },
      { name: "not-a-dir.txt", isDirectory: () => false },
    ]);
    rm.mockResolvedValue(undefined);

    expect(await clearRuns()).toBe(2);
    expect(rm).toHaveBeenCalledTimes(2);
  });

  it("skips a folder that fails to delete instead of aborting the rest", async () => {
    readdir.mockResolvedValue([
      { name: "2026-01-01T00-00-00-000Z-app-a", isDirectory: () => true },
      { name: "2026-01-02T00-00-00-000Z-app-b", isDirectory: () => true },
    ]);
    rm.mockRejectedValueOnce(new Error("EBUSY")).mockResolvedValueOnce(undefined);

    expect(await clearRuns()).toBe(1);
  });
});
