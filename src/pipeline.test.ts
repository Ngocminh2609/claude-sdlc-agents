import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpecInput } from "./types.js";

const runSpecsArch = vi.fn();
const reviewSpecs = vi.fn();
const breakDownTasks = vi.fn();
const runCoding = vi.fn();
const runE2eTest = vi.fn();

vi.mock("./stages/specs-arch.js", () => ({ runSpecsArch }));
vi.mock("./stages/orchestrator-review.js", () => ({ reviewSpecs }));
vi.mock("./stages/task-breakdown.js", () => ({ breakDownTasks }));
vi.mock("./stages/coding.js", () => ({ runCoding }));
vi.mock("./stages/e2e-test.js", () => ({ runE2eTest }));

const { runPipeline } = await import("./pipeline.js");

const spec: SpecInput = { specMarkdown: "do the thing", projectPath: "/tmp/project" };

beforeEach(() => {
  vi.clearAllMocks();
  runSpecsArch.mockResolvedValue("a proposal");
  breakDownTasks.mockResolvedValue({ tasks: [{ id: "task-1", description: "do it" }] });
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
    const secondCallFeedback = runCoding.mock.calls[1][2];
    expect(secondCallFeedback).toContain("shows a success toast");
    expect(secondCallFeedback).toContain("no test found");
  });

  it("catches an unexpected throw and returns errored with a generic message", async () => {
    reviewSpecs.mockRejectedValue(new Error("ECONNRESET at /home/user/secret/path.ts:42"));

    const result = await runPipeline({ spec });

    expect(result.status).toBe("errored");
    expect(result.message).not.toContain("ECONNRESET");
    expect(result.message).not.toContain("secret/path.ts");
  });
});
