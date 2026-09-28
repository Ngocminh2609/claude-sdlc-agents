import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloneInput } from "./types.js";

const inventoryReferences = vi.fn();
const readTargetConventions = vi.fn();
const mapCloneTargets = vi.fn();
const portCloneGroup = vi.fn();
const verifyCloneBuild = vi.fn();
const checkCoverage = vi.fn();
const checkWiring = vi.fn();
const runCloneTests = vi.fn();
const fixCloneFailures = vi.fn();
const passingTests = {
  ok: true,
  summary: "12 tests",
  commands: ["cd be && mvn test"],
  testFiles: ["src/test/java/CtlTest.java"],
  passed: 12,
  failed: 0,
  failures: [],
};
const getCachedTargetConventions = vi.fn();
const storeTargetConventions = vi.fn();
const loadCheckpoint = vi.fn();
const saveCheckpoint = vi.fn();
const clearCheckpoint = vi.fn();
const findFreePorts = vi.fn();

vi.mock("./free-ports.js", () => ({ findFreePorts }));

vi.mock("./checkpoint.js", () => ({
  fingerprint: (parts: unknown[]) => JSON.stringify(parts),
  loadCheckpoint,
  saveCheckpoint,
  clearCheckpoint,
}));

vi.mock("./stages/reference-inventory.js", () => ({ inventoryReferences }));
vi.mock("./stages/target-conventions.js", () => ({ readTargetConventions }));
vi.mock("./target-conventions-cache.js", () => ({
  getCachedTargetConventions,
  storeTargetConventions,
}));
vi.mock("./stages/clone-mapping.js", () => ({ mapCloneTargets }));
vi.mock("./stages/clone-build.js", () => ({ verifyCloneBuild }));
vi.mock("./clone-coverage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./clone-coverage.js")>()),
  checkCoverage,
}));
vi.mock("./clone-wiring.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./clone-wiring.js")>()),
  checkWiring,
}));
vi.mock("./stages/clone-port.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./stages/clone-port.js")>()),
  portCloneGroup,
  fixCloneFailures,
}));
vi.mock("./stages/clone-tests.js", () => ({ runCloneTests }));

const { runClonePipeline } = await import("./clone-pipeline.js");

const clone: CloneInput = {
  what: "Danh mục nghề nghiệp",
  projectPath: "/tmp/target",
  referencePaths: ["/tmp/sample"],
};

const mapping = {
  entries: [
    { source: "sql/occupations.sql", target: "SQL/occupations.sql", group: "SQL", changes: "prefix" },
    { source: "be/Ctl.java", target: "BE/Ctl.java", group: "BE:category", changes: "package" },
    { source: "be/Svc.java", target: "BE/Svc.java", group: "BE:category", changes: "package" },
  ],
  notes: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  inventoryReferences.mockResolvedValue({ files: [{ path: "be/Ctl.java", role: "controller" }], notes: "" });
  readTargetConventions.mockResolvedValue({ summary: "modules/ layout, vn.gov root" });
  getCachedTargetConventions.mockResolvedValue(null);
  storeTargetConventions.mockResolvedValue(undefined);
  loadCheckpoint.mockResolvedValue({ status: "none" });
  saveCheckpoint.mockResolvedValue(undefined);
  clearCheckpoint.mockResolvedValue(undefined);
  findFreePorts.mockResolvedValue([50001, 50002, 50003]);
  mapCloneTargets.mockResolvedValue(mapping);
  portCloneGroup.mockResolvedValue({ summary: "ported", deviations: [] });
  verifyCloneBuild.mockResolvedValue({ ok: true, summary: "compiled" });
  checkCoverage.mockReturnValue({ present: mapping.entries.map((e) => e.target), missing: [] });
  checkWiring.mockReturnValue({ unresolvedImports: [], unmatchedCalls: [], callsChecked: 0, endpointsKnown: 0 });
  runCloneTests.mockResolvedValue(passingTests);
  fixCloneFailures.mockResolvedValue("fixed");
});

describe("runClonePipeline", () => {
  it("runs one port per group, not one per file, in mapping order", async () => {
    await runClonePipeline({ clone });

    expect(portCloneGroup).toHaveBeenCalledTimes(2);
    expect(portCloneGroup.mock.calls.map(([request]) => request.group)).toEqual(["SQL", "BE:category"]);
  });

  it("reports done only when every mapped file exists and the build passes", async () => {
    const result = await runClonePipeline({ clone });

    expect(result.status).toBe("done");
    expect(result.message).toContain("3/3 file(s) present");
  });

  it("reports incomplete and names the files when coverage has holes", async () => {
    checkCoverage.mockReturnValue({ present: ["SQL/occupations.sql"], missing: ["BE/Ctl.java"] });

    const result = await runClonePipeline({ clone });

    expect(result.status).toBe("incomplete");
    expect(result.message).toContain("BE/Ctl.java");
    expect(result.message).toContain("not reverted");
  });

  it("reports incomplete when the build fails, even with full coverage", async () => {
    verifyCloneBuild.mockResolvedValue({ ok: false, summary: "cannot find symbol", errors: ["Ctl.java:12"] });

    const result = await runClonePipeline({ clone });

    expect(result.status).toBe("incomplete");
    expect(result.message).toContain("Ctl.java:12");
  });

  it("writes nothing when the mapping stage produced no mapping", async () => {
    mapCloneTargets.mockResolvedValue(null);

    const result = await runClonePipeline({ clone });

    expect(result.status).toBe("incomplete");
    expect(portCloneGroup).not.toHaveBeenCalled();
  });

  it("stops before touching the target when the feature is not found in the reference", async () => {
    inventoryReferences.mockResolvedValue({ files: [], notes: "" });

    const result = await runClonePipeline({ clone });

    expect(result.status).toBe("incomplete");
    expect(mapCloneTargets).not.toHaveBeenCalled();
    expect(portCloneGroup).not.toHaveBeenCalled();
  });

  it("carries on when the target conventions could not be read", async () => {
    readTargetConventions.mockResolvedValue(null);

    const result = await runClonePipeline({ clone });

    expect(result.status).toBe("done");
    expect(mapCloneTargets).toHaveBeenCalledWith(clone, expect.anything(), null);
  });

  it("skips the build check on request without calling it done falsely", async () => {
    const result = await runClonePipeline({ clone, skipBuild: true });

    expect(verifyCloneBuild).not.toHaveBeenCalled();
    expect(result.message).toContain("Build: not checked");
    expect(result.status).toBe("done");
  });

  it("tells each group what the groups before it produced", async () => {
    await runClonePipeline({ clone });

    expect(portCloneGroup.mock.calls[0][0].completedGroups).toEqual([]);
    expect(portCloneGroup.mock.calls[1][0].completedGroups).toEqual([
      { group: "SQL", summary: "ported", deviations: [] },
    ]);
  });

  it("flags uncertain mapping rows in the final message", async () => {
    mapCloneTargets.mockResolvedValue({
      entries: [{ ...mapping.entries[0], uncertain: true }],
      notes: "",
    });
    checkCoverage.mockReturnValue({ present: ["SQL/occupations.sql"], missing: [] });

    const result = await runClonePipeline({ clone });

    expect(result.message).toContain("uncertain");
  });

  it("reuses cached conventions instead of calling the agent when the project is unchanged", async () => {
    getCachedTargetConventions.mockResolvedValue({ summary: "cached: modules/ layout" });
    const progress: string[] = [];

    await runClonePipeline({ clone, onProgress: (message) => progress.push(message) });

    expect(readTargetConventions).not.toHaveBeenCalled();
    expect(storeTargetConventions).not.toHaveBeenCalled();
    expect(mapCloneTargets).toHaveBeenCalledWith(
      clone,
      expect.anything(),
      { summary: "cached: modules/ layout" },
    );
    expect(progress).toContain("Clone conventions: reused from a previous run (target project structure unchanged)");
  });

  it("stores freshly computed conventions for next time on a cache miss", async () => {
    await runClonePipeline({ clone });

    expect(readTargetConventions).toHaveBeenCalledTimes(1);
    expect(storeTargetConventions).toHaveBeenCalledWith(
      [{ role: "app", path: clone.projectPath }],
      { summary: "modules/ layout, vn.gov root" },
      undefined,
    );
  });

  it("works with separate BE/FE target folders: coverage and build see both", async () => {
    const split = {
      ...clone,
      targetRoots: [
        { role: "be" as const, path: "/tmp/target-be" },
        { role: "fe" as const, path: "/tmp/target-fe" },
      ],
      projectPath: "/tmp/target-be",
    };

    await runClonePipeline({ clone: split });

    expect(checkCoverage.mock.calls.at(-1)?.[1]).toEqual(split.targetRoots);
    expect(verifyCloneBuild.mock.calls[0][2]).toEqual(split.targetRoots);
  });

  it("passes the port agents' declared deviations to coverage and reports them apart from missing files", async () => {
    portCloneGroup
      .mockResolvedValueOnce({ summary: "sql done", deviations: [] })
      .mockResolvedValueOnce({
        summary: "be done",
        deviations: [{ target: "BE/Svc.java", kind: "merged", coveredBy: "BE/Ctl.java", reason: "one class per entity" }],
      });
    checkCoverage.mockReturnValue({
      present: ["SQL/occupations.sql", "BE/Ctl.java"],
      missing: [],
      merged: [{ target: "BE/Svc.java", kind: "merged", coveredBy: "BE/Ctl.java", reason: "one class per entity" }],
    });

    const result = await runClonePipeline({ clone });

    expect(checkCoverage.mock.calls.at(-1)?.[2]).toEqual([
      { target: "BE/Svc.java", kind: "merged", coveredBy: "BE/Ctl.java", reason: "one class per entity" },
    ]);
    expect(result.status).toBe("done");
    expect(result.message).toContain("BE/Svc.java -> in BE/Ctl.java");
  });

  it("reports incomplete when a ported page imports a file nobody wrote, even with every mapped file present", async () => {
    checkWiring.mockReturnValue({
      unresolvedImports: [{ file: "FE: src/pages/x/index.tsx", specifier: "@/services/apis/statsIndicators" }],
      unmatchedCalls: [],
      callsChecked: 0,
      endpointsKnown: 12,
    });

    const result = await runClonePipeline({ clone });

    expect(result.status).toBe("incomplete");
    expect(result.message).toContain("@/services/apis/statsIndicators");
  });

  it("runs the wiring check even when the build is skipped", async () => {
    checkWiring.mockReturnValue({
      unresolvedImports: [],
      unmatchedCalls: [{ file: "FE: src/services/apis/x.ts", method: "GET", url: "/x/search" }],
      callsChecked: 1,
      endpointsKnown: 3,
    });

    const result = await runClonePipeline({ clone, skipBuild: true });

    expect(checkWiring).toHaveBeenCalled();
    expect(result.status).toBe("incomplete");
    expect(result.message).toContain("GET /x/search");
  });

  it("ports database scripts, then server, then client — whatever order the mapping lists them in", async () => {
    mapCloneTargets.mockResolvedValue({
      entries: [
        { source: "fe/page.tsx", target: "FE/page.tsx", group: "FE", layer: "fe", changes: "" },
        { source: "be/Ctl.java", target: "BE/Ctl.java", group: "BE", layer: "be", changes: "" },
        { source: "(new)", target: "db/schema.sql", group: "SQL", layer: "db", changes: "tables" },
      ],
      notes: "",
    });

    await runClonePipeline({ clone });

    expect(portCloneGroup.mock.calls.map(([request]) => request.group)).toEqual(["SQL", "BE", "FE"]);
    // Only the client group is handed the server API read from disk.
    expect(portCloneGroup.mock.calls.map(([request]) => Array.isArray(request.serverApi))).toEqual([false, false, true]);
  });

  it("warns when entities are ported without any database script", async () => {
    mapCloneTargets.mockResolvedValue({
      entries: [{ source: "e.java", target: "src/main/java/x/entities/Stats.java", group: "BE", layer: "be", changes: "" }],
      notes: "",
    });
    const progress: string[] = [];

    const result = await runClonePipeline({ clone, onProgress: (message) => progress.push(message) });

    expect(progress.some((message) => message.startsWith("Clone mapping: warning"))).toBe(true);
    expect(result.message).toContain("no database script");
  });

  it("fixes the ported code when a unit test fails, re-runs, and reports done once it passes", async () => {
    const failing = { ...passingTests, ok: false, passed: 11, failed: 1, failures: ["CtlTest.delete: expected 204 but was 500"] };
    runCloneTests.mockResolvedValueOnce(failing).mockResolvedValueOnce(passingTests);

    const result = await runClonePipeline({ clone });

    expect(fixCloneFailures).toHaveBeenCalledTimes(1);
    expect(fixCloneFailures.mock.calls[0][0].failures).toEqual(["[test] CtlTest.delete: expected 204 but was 500"]);
    // The second run re-runs the first run's commands instead of writing new tests.
    expect(runCloneTests.mock.calls[1][0].rerun).toEqual(failing);
    // The build is checked again after a fix: the fix touched the code.
    expect(verifyCloneBuild).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("done");
  });

  it("gives up after the configured fix rounds and reports the tests still failing", async () => {
    runCloneTests.mockResolvedValue({ ...passingTests, ok: false, failed: 1, failures: ["SvcTest.create: NPE"] });

    const result = await runClonePipeline({ clone });

    expect(fixCloneFailures).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("incomplete");
    expect(result.message).toContain("SvcTest.create: NPE");
  });

  it("does not write or run tests when asked to skip them", async () => {
    const result = await runClonePipeline({ clone, skipTests: true });

    expect(runCloneTests).not.toHaveBeenCalled();
    expect(result.message).toContain("Unit tests: not run.");
  });

  it("treats the request as a keyword and tells later stages what it matched", async () => {
    inventoryReferences.mockResolvedValue({
      files: [{ path: "be/OccupationController.java", role: "controller" }],
      notes: "",
      resolvedFeature: "Occupation catalogue (Danh mục nghề nghiệp)",
      alternatives: ["Occupation groups"],
    });
    const progress: string[] = [];

    await runClonePipeline({ clone: { ...clone, what: "nghề nghiệp" }, onProgress: (m) => progress.push(m) });

    const locateSpec = inventoryReferences.mock.calls[0][0].specMarkdown as string;
    expect(locateSpec).toContain("nghe_nghiep");
    expect(locateSpec).toContain("NgheNghiep");
    expect(locateSpec).toMatch(/Vietnamese <-> English/);
    expect(locateSpec).toMatch(/choose the single best one/);
    expect(mapCloneTargets.mock.calls[0][0].what).toContain("Occupation catalogue");
    expect(portCloneGroup.mock.calls[0][0].clone.what).toContain("Occupation catalogue");
    expect(progress.some((line) => line.includes('matched "Occupation catalogue'))).toBe(true);
  });

  it("does not cache a failed conventions read", async () => {
    readTargetConventions.mockResolvedValue(null);

    await runClonePipeline({ clone });

    expect(storeTargetConventions).not.toHaveBeenCalled();
  });

  it("resumes a stopped clone: skips locate, conventions, mapping and ported groups", async () => {
    loadCheckpoint.mockResolvedValue({
      status: "found",
      savedAt: "2026-09-24T01:00:00Z",
      data: {
        inventory: { files: [{ path: "be/Ctl.java", role: "controller" }], notes: "" },
        conventions: { summary: "modules/ layout" },
        mapping,
        completedGroups: [{ group: "SQL", summary: "ported earlier" }],
      },
    });
    // The SQL group's file is on disk, so the saved progress is trusted.
    checkCoverage.mockReturnValue({ present: ["SQL/occupations.sql"], missing: [] });

    await runClonePipeline({ clone });

    expect(inventoryReferences).not.toHaveBeenCalled();
    expect(readTargetConventions).not.toHaveBeenCalled();
    expect(mapCloneTargets).not.toHaveBeenCalled();
    expect(portCloneGroup.mock.calls.map(([request]) => request.group)).toEqual(["BE:category"]);
    expect(portCloneGroup.mock.calls[0][0].completedGroups).toEqual([{ group: "SQL", summary: "ported earlier" }]);
  });

  it("saves progress after the mapping and after every group, and clears it when done", async () => {
    await runClonePipeline({ clone });

    expect(saveCheckpoint.mock.calls.map(([, , , data]) => data.completedGroups.length)).toEqual([0, 1, 2]);
    expect(clearCheckpoint).toHaveBeenCalledWith("clone", clone.projectPath);
  });

  it("keeps the progress when the port is incomplete", async () => {
    checkCoverage.mockReturnValue({ present: [], missing: ["BE/Ctl.java"] });

    await runClonePipeline({ clone });

    expect(clearCheckpoint).not.toHaveBeenCalled();
  });

  it("hands every port group, the build check and the unit tests a fresh set of free ports", async () => {
    await runClonePipeline({ clone });

    for (const [request] of portCloneGroup.mock.calls) {
      expect(request.runtimePorts).toEqual([50001, 50002, 50003]);
    }
    expect(verifyCloneBuild.mock.calls[0][1]).toEqual([50001, 50002, 50003]);
    expect(runCloneTests.mock.calls[0][0].runtimePorts).toEqual([50001, 50002, 50003]);
    expect(findFreePorts).toHaveBeenCalledTimes(4); // two groups + the build + the tests
  });

  it("ignores saved progress when asked to start fresh", async () => {
    await runClonePipeline({ clone, fresh: true });

    expect(loadCheckpoint).not.toHaveBeenCalled();
    expect(inventoryReferences).toHaveBeenCalled();
  });

  it("catches an unexpected throw and reports errored without leaking detail", async () => {
    mapCloneTargets.mockRejectedValue(new Error("ECONNRESET at /home/user/secret.ts:9"));

    const result = await runClonePipeline({ clone });

    expect(result.status).toBe("errored");
    expect(result.message).not.toContain("secret.ts");
  });
});
