import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpecInput } from "./types.js";

const runSpecsArch = vi.fn();
const reviewSpecs = vi.fn();
const breakDownTasks = vi.fn();
const runCoding = vi.fn();
const runE2eTest = vi.fn();
const inventoryReferences = vi.fn();
const inventoryProjectContext = vi.fn();
const findFreePorts = vi.fn();
const loadCheckpoint = vi.fn();
const saveCheckpoint = vi.fn();
const clearCheckpoint = vi.fn();

vi.mock("./free-ports.js", () => ({ findFreePorts }));
vi.mock("./checkpoint.js", () => ({
  fingerprint: (parts: unknown[]) => JSON.stringify(parts),
  loadCheckpoint,
  saveCheckpoint,
  clearCheckpoint,
}));
vi.mock("./stages/specs-arch.js", () => ({ runSpecsArch }));
vi.mock("./stages/orchestrator-review.js", () => ({ reviewSpecs }));
vi.mock("./stages/task-breakdown.js", () => ({ breakDownTasks }));
vi.mock("./stages/coding.js", () => ({ runCoding }));
vi.mock("./stages/e2e-test.js", () => ({ runE2eTest }));
vi.mock("./stages/reference-inventory.js", () => ({ inventoryReferences }));
vi.mock("./stages/project-context.js", () => ({ inventoryProjectContext }));

const { runPipeline } = await import("./pipeline.js");
const { StageError } = await import("./stage-error.js");

const spec: SpecInput = { specMarkdown: "do the thing", projectPath: "/tmp/project" };

beforeEach(() => {
  vi.clearAllMocks();
  runSpecsArch.mockResolvedValue("a proposal");
  breakDownTasks.mockResolvedValue({ tasks: [{ id: "task-1", description: "do it" }] });
  inventoryReferences.mockResolvedValue(null);
  inventoryProjectContext.mockResolvedValue(null);
  findFreePorts.mockResolvedValue([50001, 50002, 50003]);
  loadCheckpoint.mockResolvedValue({ status: "none" });
  saveCheckpoint.mockResolvedValue(undefined);
  clearCheckpoint.mockResolvedValue(undefined);
});

const savedPlan = {
  inventory: null,
  projectContext: null,
  approvedProposal: "the saved design",
  tasks: [
    { id: "task-1", description: "a" },
    { id: "task-2", description: "b" },
    { id: "task-3", description: "c" },
  ],
  completedTasks: [{ id: "task-1", description: "a", summary: "did a" }],
};

describe("runPipeline — resuming a stopped run", () => {
  it("skips design, review, breakdown and finished tasks, and codes only what is left", async () => {
    loadCheckpoint.mockResolvedValue({ status: "found", savedAt: "2026-09-24T01:00:00Z", data: savedPlan });
    runCoding.mockResolvedValue("implemented");
    runE2eTest.mockResolvedValue({ verdict: "pass", summary: "all good" });
    const progress: string[] = [];

    const result = await runPipeline({ spec, onProgress: (message) => progress.push(message) });

    expect(result.status).toBe("done");
    expect(inventoryProjectContext).not.toHaveBeenCalled();
    expect(runSpecsArch).not.toHaveBeenCalled();
    expect(reviewSpecs).not.toHaveBeenCalled();
    expect(breakDownTasks).not.toHaveBeenCalled();
    expect(runCoding.mock.calls.map(([request]) => request.task.id)).toEqual(["task-2", "task-3"]);
    // The saved design and the finished task's summary carry into the rest.
    expect(runCoding.mock.calls[0][0].approvedProposal).toBe("the saved design");
    expect(runCoding.mock.calls[0][0].completedTasks).toEqual(savedPlan.completedTasks);
    expect(progress.some((line) => line.startsWith("Resume: continuing"))).toBe(true);
    expect(progress).toContain("3 task(s) to implement");
  });

  it("goes straight to E2E when every task had already finished", async () => {
    loadCheckpoint.mockResolvedValue({
      status: "found",
      savedAt: "2026-09-24T01:00:00Z",
      data: {
        ...savedPlan,
        completedTasks: savedPlan.tasks.map((task) => ({ ...task, summary: "done" })),
      },
    });
    runE2eTest.mockResolvedValue({ verdict: "pass", summary: "all good" });

    await runPipeline({ spec });

    expect(runCoding).not.toHaveBeenCalled();
    expect(runE2eTest).toHaveBeenCalledTimes(1);
  });

  it("saves progress after the breakdown and after every finished task", async () => {
    reviewSpecs.mockResolvedValue({ decision: "approve", feedback: "" });
    breakDownTasks.mockResolvedValue({
      tasks: [
        { id: "task-1", description: "a" },
        { id: "task-2", description: "b" },
      ],
    });
    runCoding.mockResolvedValue("implemented");
    runE2eTest.mockResolvedValue({ verdict: "fail", summary: "broken" });

    await runPipeline({ spec });

    const saves = saveCheckpoint.mock.calls.map(([, , , data]) => data.completedTasks.length);
    expect(saves).toEqual([0, 1, 2]);
    // An E2E failure keeps the progress, so the next run goes straight to E2E.
    expect(clearCheckpoint).not.toHaveBeenCalled();
  });

  it("clears the saved progress once the run is done", async () => {
    reviewSpecs.mockResolvedValue({ decision: "approve", feedback: "" });
    runCoding.mockResolvedValue("implemented");
    runE2eTest.mockResolvedValue({ verdict: "pass", summary: "all good" });

    await runPipeline({ spec });

    expect(clearCheckpoint).toHaveBeenCalledWith("feature", spec.projectPath);
  });

  it("keeps the progress when a task fails, and says the next run resumes there", async () => {
    reviewSpecs.mockResolvedValue({ decision: "approve", feedback: "" });
    runCoding.mockRejectedValue(new StageError("coding stage failed on task task-1: rate_limit"));

    const result = await runPipeline({ spec });

    expect(result.message).toContain("resumes at task-1");
    expect(clearCheckpoint).not.toHaveBeenCalled();
  });

  it("ignores saved progress and plans from scratch when asked to start fresh", async () => {
    loadCheckpoint.mockResolvedValue({ status: "found", savedAt: "2026-09-24T01:00:00Z", data: savedPlan });
    reviewSpecs.mockResolvedValue({ decision: "approve", feedback: "" });
    runCoding.mockResolvedValue("implemented");
    runE2eTest.mockResolvedValue({ verdict: "pass", summary: "all good" });

    await runPipeline({ spec, fresh: true });

    expect(clearCheckpoint).toHaveBeenCalledWith("feature", spec.projectPath);
    expect(loadCheckpoint).not.toHaveBeenCalled();
    expect(runSpecsArch).toHaveBeenCalled();
  });

  it("starts fresh and says why when the saved progress is for a different spec", async () => {
    loadCheckpoint.mockResolvedValue({ status: "stale", savedAt: "2026-09-24T01:00:00Z" });
    reviewSpecs.mockResolvedValue({ decision: "approve", feedback: "" });
    runCoding.mockResolvedValue("implemented");
    runE2eTest.mockResolvedValue({ verdict: "pass", summary: "all good" });
    const progress: string[] = [];

    await runPipeline({ spec, onProgress: (message) => progress.push(message) });

    expect(runSpecsArch).toHaveBeenCalled();
    expect(progress.some((line) => line.includes("different spec"))).toBe(true);
  });

  it("starts fresh when every file the finished tasks wrote has been deleted", async () => {
    loadCheckpoint.mockResolvedValue({
      status: "found",
      savedAt: "2026-09-24T01:00:00Z",
      data: {
        ...savedPlan,
        tasks: [{ id: "task-1", description: "a", targetFiles: ["definitely/not/here.ts"] }, savedPlan.tasks[1]],
      },
    });
    reviewSpecs.mockResolvedValue({ decision: "approve", feedback: "" });
    runCoding.mockResolvedValue("implemented");
    runE2eTest.mockResolvedValue({ verdict: "pass", summary: "all good" });
    const progress: string[] = [];

    await runPipeline({ spec, onProgress: (message) => progress.push(message) });

    expect(runSpecsArch).toHaveBeenCalled();
    expect(progress.some((line) => line.includes("are on disk any more"))).toBe(true);
  });
});

describe("runPipeline", () => {
  it("escalates when the orchestrator never approves the proposal", async () => {
    reviewSpecs.mockResolvedValue({ decision: "reject", feedback: "not detailed enough" });

    const result = await runPipeline({ spec });

    expect(result.status).toBe("escalated-specs");
    expect(reviewSpecs).toHaveBeenCalledTimes(3);
    expect(breakDownTasks).not.toHaveBeenCalled();
    expect(runCoding).not.toHaveBeenCalled();
  });

  it("runs coding once per task and finishes when E2E passes on the first attempt", async () => {
    reviewSpecs.mockResolvedValue({ decision: "approve", feedback: "" });
    breakDownTasks.mockResolvedValue({
      tasks: [
        { id: "task-1", description: "endpoint A" },
        { id: "task-2", description: "endpoint B" },
      ],
    });
    runCoding.mockResolvedValue("implemented");
    runE2eTest.mockResolvedValue({ verdict: "pass", summary: "all good" });

    const result = await runPipeline({ spec });

    expect(result.status).toBe("done");
    expect(runCoding).toHaveBeenCalledTimes(2);
    expect(runE2eTest).toHaveBeenCalledTimes(1);
  });

  it("stops after a failed E2E instead of re-coding every task from the first one", async () => {
    reviewSpecs.mockResolvedValue({ decision: "approve", feedback: "" });
    breakDownTasks.mockResolvedValue({
      tasks: [
        { id: "task-1", description: "the API" },
        { id: "task-2", description: "the screen" },
      ],
    });
    runCoding.mockResolvedValue("implemented");
    runE2eTest.mockResolvedValue({
      verdict: "fail",
      summary: "AC2 not covered",
      failedScenarios: ["login flow"],
      acceptanceCriteria: [{ criterion: "shows a success toast", covered: false, evidence: "no test found" }],
    });

    const result = await runPipeline({ spec });

    expect(result.status).toBe("escalated-e2e");
    expect(runE2eTest).toHaveBeenCalledTimes(1);
    expect(runCoding).toHaveBeenCalledTimes(2); // once per task, never a second pass
    expect(result.message).toContain("not re-coded");
    expect(result.message).toContain("login flow");
    expect(result.message).toContain("shows a success toast");
    expect(result.message).toContain("no test found");
  });

  it("stops at the coding task that failed and says what finished and what did not", async () => {
    reviewSpecs.mockResolvedValue({ decision: "approve", feedback: "" });
    breakDownTasks.mockResolvedValue({
      tasks: [
        { id: "task-1", description: "a" },
        { id: "task-2", description: "b" },
        { id: "task-3", description: "c" },
      ],
    });
    runCoding
      .mockResolvedValueOnce("done a")
      .mockRejectedValueOnce(
        new StageError("coding stage failed on task task-2: SDK reported an error mid-run: rate_limit"),
      );

    const result = await runPipeline({ spec });

    expect(result.status).toBe("errored");
    expect(runCoding).toHaveBeenCalledTimes(2);
    expect(runE2eTest).not.toHaveBeenCalled();
    expect(result.message).toContain("task-2 (2/3)");
    expect(result.message).toContain("rate_limit");
    expect(result.message).toContain("Finished before it: task-1");
    expect(result.message).toContain("Not started: task-3");
  });

  it("surfaces a stage's own failure message instead of a generic one", async () => {
    runSpecsArch.mockRejectedValue(new StageError("specs-arch stage failed: SDK reported an error mid-run: rate_limit"));

    const result = await runPipeline({ spec });

    expect(result.status).toBe("errored");
    expect(result.message).toContain("rate_limit");
    expect(result.message).not.toContain("unexpected error");
  });

  it("hands every coding task and the E2E stage a fresh set of free ports", async () => {
    reviewSpecs.mockResolvedValue({ decision: "approve", feedback: "" });
    runCoding.mockResolvedValue("implemented");
    runE2eTest.mockResolvedValue({ verdict: "pass", summary: "all good" });

    await runPipeline({ spec });

    expect(runCoding.mock.calls[0][0].runtimePorts).toEqual([50001, 50002, 50003]);
    expect(runE2eTest.mock.calls[0][3]).toEqual([50001, 50002, 50003]);
    expect(findFreePorts).toHaveBeenCalledTimes(2); // one coding task + E2E
  });

  it("gives every coding task the approved design", async () => {
    reviewSpecs.mockResolvedValue({ decision: "approve", feedback: "" });
    runSpecsArch.mockResolvedValue("the approved design");
    breakDownTasks.mockResolvedValue({
      tasks: [
        { id: "task-1", description: "the API" },
        { id: "task-2", description: "the screen" },
      ],
    });
    runCoding.mockResolvedValue("implemented");
    runE2eTest.mockResolvedValue({ verdict: "pass", summary: "all good" });

    await runPipeline({ spec });

    for (const [request] of runCoding.mock.calls) {
      expect(request.approvedProposal).toBe("the approved design");
    }
  });

  it("hands each task what the tasks before it produced", async () => {
    reviewSpecs.mockResolvedValue({ decision: "approve", feedback: "" });
    breakDownTasks.mockResolvedValue({
      tasks: [
        { id: "task-1", description: "the API" },
        { id: "task-2", description: "the screen" },
      ],
    });
    runCoding.mockResolvedValue("added GET /api/units");
    runE2eTest.mockResolvedValue({ verdict: "pass", summary: "all good" });

    await runPipeline({ spec });

    const completed = runCoding.mock.calls.map(([request]) => request.completedTasks);
    expect(completed[0]).toEqual([]);
    expect(completed[1]).toEqual([
      { id: "task-1", description: "the API", summary: "added GET /api/units" },
    ]);
  });

  it("skips the inventory stage entirely when no reference repo was given", async () => {
    reviewSpecs.mockResolvedValue({ decision: "approve", feedback: "" });
    runCoding.mockResolvedValue("implemented");
    runE2eTest.mockResolvedValue({ verdict: "pass", summary: "all good" });
    const progress: string[] = [];

    await runPipeline({ spec, onProgress: (message) => progress.push(message) });

    expect(inventoryReferences).not.toHaveBeenCalled();
    expect(progress).toContain("Reference inventory: skipped (no reference repository)");
  });

  it("scans the references once and hands the list to every stage that reads them", async () => {
    const withReference = { ...spec, referencePaths: ["/tmp/sample"] };
    const inventory = { files: [{ path: "src/a.ts", role: "the endpoint" }], notes: "" };
    inventoryReferences.mockResolvedValue(inventory);
    reviewSpecs.mockResolvedValue({ decision: "approve", feedback: "" });
    runCoding.mockResolvedValue("implemented");
    runE2eTest.mockResolvedValue({ verdict: "pass", summary: "all good" });

    await runPipeline({ spec: withReference });

    expect(inventoryReferences).toHaveBeenCalledTimes(1);
    expect(runSpecsArch.mock.calls[0][3]).toBe(inventory);
    expect(breakDownTasks.mock.calls[0][2]).toBe(inventory);
    expect(runCoding.mock.calls[0][0].inventory).toBe(inventory);
  });

  it("reports a failed scan and carries on instead of silently pretending it had a list", async () => {
    const withReference = { ...spec, referencePaths: ["/tmp/sample"] };
    inventoryReferences.mockResolvedValue(null);
    reviewSpecs.mockResolvedValue({ decision: "approve", feedback: "" });
    runCoding.mockResolvedValue("implemented");
    runE2eTest.mockResolvedValue({ verdict: "pass", summary: "all good" });
    const progress: string[] = [];

    const result = await runPipeline({
      spec: withReference,
      onProgress: (message) => progress.push(message),
    });

    expect(result.status).toBe("done");
    expect(progress).toContain("Reference inventory: unavailable — continuing without a file list");
    expect(runSpecsArch.mock.calls[0][3]).toBeNull();
  });

  it("scans the project context once and hands it to every stage that reads it", async () => {
    const context = { conventions: "kebab-case, tests alongside source", relevantFiles: [], notes: "" };
    inventoryProjectContext.mockResolvedValue(context);
    reviewSpecs.mockResolvedValue({ decision: "approve", feedback: "" });
    runCoding.mockResolvedValue("implemented");
    runE2eTest.mockResolvedValue({ verdict: "pass", summary: "all good" });

    await runPipeline({ spec });

    expect(inventoryProjectContext).toHaveBeenCalledTimes(1);
    expect(runSpecsArch.mock.calls[0][4]).toBe(context);
    expect(breakDownTasks.mock.calls[0][3]).toBe(context);
    expect(runCoding.mock.calls[0][0].projectContext).toBe(context);
    expect(runE2eTest.mock.calls[0][2]).toBe(context);
  });

  it("reports an unavailable project context and carries on instead of crashing", async () => {
    inventoryProjectContext.mockResolvedValue(null);
    reviewSpecs.mockResolvedValue({ decision: "approve", feedback: "" });
    runCoding.mockResolvedValue("implemented");
    runE2eTest.mockResolvedValue({ verdict: "pass", summary: "all good" });
    const progress: string[] = [];

    const result = await runPipeline({ spec, onProgress: (message) => progress.push(message) });

    expect(result.status).toBe("done");
    expect(progress).toContain("Project context: unavailable — stages will explore the project themselves");
  });

  it("catches an unexpected throw and returns errored with a generic message", async () => {
    reviewSpecs.mockRejectedValue(new Error("ECONNRESET at /home/user/secret/path.ts:42"));

    const result = await runPipeline({ spec });

    expect(result.status).toBe("errored");
    expect(result.message).not.toContain("ECONNRESET");
    expect(result.message).not.toContain("secret/path.ts");
  });
});
