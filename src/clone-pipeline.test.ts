import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloneInput } from "./types.js";

const inventoryReferences = vi.fn();
const readTargetConventions = vi.fn();
const mapCloneTargets = vi.fn();
const portCloneGroup = vi.fn();
const verifyCloneBuild = vi.fn();
const checkCoverage = vi.fn();

vi.mock("./stages/reference-inventory.js", () => ({ inventoryReferences }));
vi.mock("./stages/target-conventions.js", () => ({ readTargetConventions }));
vi.mock("./stages/clone-mapping.js", () => ({ mapCloneTargets }));
vi.mock("./stages/clone-build.js", () => ({ verifyCloneBuild }));
vi.mock("./clone-coverage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./clone-coverage.js")>()),
  checkCoverage,
}));
vi.mock("./stages/clone-port.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./stages/clone-port.js")>()),
  portCloneGroup,
}));

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
  mapCloneTargets.mockResolvedValue(mapping);
  portCloneGroup.mockResolvedValue("ported");
  verifyCloneBuild.mockResolvedValue({ ok: true, summary: "compiled" });
  checkCoverage.mockReturnValue({ present: mapping.entries.map((e) => e.target), missing: [] });
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
      { group: "SQL", summary: "ported" },
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

  it("catches an unexpected throw and reports errored without leaking detail", async () => {
    mapCloneTargets.mockRejectedValue(new Error("ECONNRESET at /home/user/secret.ts:9"));

    const result = await runClonePipeline({ clone });

    expect(result.status).toBe("errored");
    expect(result.message).not.toContain("secret.ts");
  });
});
