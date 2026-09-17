import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpecInput } from "./types.js";

const runSpecsArch = vi.fn();
const reviewSpecs = vi.fn();
const breakDownTasks = vi.fn();
const runCoding = vi.fn();
const runE2eTest = vi.fn();
const inventoryReferences = vi.fn();

vi.mock("./stages/specs-arch.js", () => ({ runSpecsArch }));
vi.mock("./stages/orchestrator-review.js", () => ({ reviewSpecs }));
vi.mock("./stages/task-breakdown.js", () => ({ breakDownTasks }));
vi.mock("./stages/coding.js", () => ({ runCoding }));
vi.mock("./stages/e2e-test.js", () => ({ runE2eTest }));
vi.mock("./stages/reference-inventory.js", () => ({ inventoryReferences }));

const { runPipeline } = await import("./pipeline.js");

const spec: SpecInput = { specMarkdown: "do the thing", projectPath: "/tmp/project" };

beforeEach(() => {
  vi.clearAllMocks();
  runSpecsArch.mockResolvedValue("a proposal");
  breakDownTasks.mockResolvedValue({ tasks: [{ id: "task-1", description: "do it" }] });
  inventoryReferences.mockResolvedValue(null);
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

  it("escalates after E2E never passes, without discarding the code already on disk", async () => {
    reviewSpecs.mockResolvedValue({ decision: "approve", feedback: "" });
    runCoding.mockResolvedValue("implemented");
    runE2eTest.mockResolvedValue({ verdict: "fail", summary: "still broken", failedScenarios: ["login flow"] });

    const result = await runPipeline({ spec });

    expect(result.status).toBe("escalated-e2e");
    expect(runE2eTest).toHaveBeenCalledTimes(3);
    expect(runCoding).toHaveBeenCalledTimes(3);
  });

  it("feeds uncovered acceptance criteria back into the next coding attempt", async () => {
    reviewSpecs.mockResolvedValue({ decision: "approve", feedback: "" });
    runCoding.mockResolvedValue("implemented");
    runE2eTest
      .mockResolvedValueOnce({
        verdict: "fail",
        summary: "AC2 not covered",
        acceptanceCriteria: [
          { criterion: "shows a success toast", covered: false, evidence: "no test found" },
        ],
      })
      .mockResolvedValueOnce({ verdict: "pass", summary: "all good" });

    await runPipeline({ spec });

    expect(runCoding).toHaveBeenCalledTimes(2);
    const secondCallFeedback = runCoding.mock.calls[1][0].priorE2eFeedback;
    expect(secondCallFeedback).toContain("shows a success toast");
    expect(secondCallFeedback).toContain("no test found");
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

  it("hands each task what the tasks before it produced, and starts a retry from empty", async () => {
    reviewSpecs.mockResolvedValue({ decision: "approve", feedback: "" });
    breakDownTasks.mockResolvedValue({
      tasks: [
        { id: "task-1", description: "the API" },
        { id: "task-2", description: "the screen" },
      ],
    });
    runCoding.mockResolvedValue("added GET /api/units");
    runE2eTest
      .mockResolvedValueOnce({ verdict: "fail", summary: "not wired up" })
      .mockResolvedValueOnce({ verdict: "pass", summary: "all good" });

    await runPipeline({ spec });

    const completed = runCoding.mock.calls.map(([request]) => request.completedTasks);
    expect(completed[0]).toEqual([]); // first task of attempt 1
    expect(completed[1]).toEqual([
      { id: "task-1", description: "the API", summary: "added GET /api/units" },
    ]);
    expect(completed[2]).toEqual([]); // attempt 2 starts over from task-1
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

  it("catches an unexpected throw and returns errored with a generic message", async () => {
    reviewSpecs.mockRejectedValue(new Error("ECONNRESET at /home/user/secret/path.ts:42"));

    const result = await runPipeline({ spec });

    expect(result.status).toBe("errored");
    expect(result.message).not.toContain("ECONNRESET");
    expect(result.message).not.toContain("secret/path.ts");
  });
});
