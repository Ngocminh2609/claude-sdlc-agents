import { describe, expect, it, vi, beforeEach } from "vitest";
import type { IssueTask } from "./types.js";

const runSpecsArch = vi.fn();
const reviewSpecs = vi.fn();
const runCoding = vi.fn();
const runQa = vi.fn();
const createBranch = vi.fn();
const commitAndPush = vi.fn();
const branchNameFor = vi.fn(() => "ai/issue-1-test");

vi.mock("./stages/specs-arch.js", () => ({ runSpecsArch }));
vi.mock("./stages/orchestrator-review.js", () => ({ reviewSpecs }));
vi.mock("./stages/coding.js", () => ({ runCoding }));
vi.mock("./stages/qa.js", () => ({ runQa }));
vi.mock("./git.js", () => ({ createBranch, commitAndPush, branchNameFor }));

const { runPipeline } = await import("./pipeline.js");

const issue: IssueTask = {
  number: 1,
  title: "Test issue",
  body: "do the thing",
  repoFullName: "org/repo",
};

function fakeGithub() {
  return { postComment: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  branchNameFor.mockReturnValue("ai/issue-1-test");
  runSpecsArch.mockResolvedValue("a proposal");
});

describe("runPipeline", () => {
  it("escalates when the orchestrator never approves the proposal", async () => {
    reviewSpecs.mockResolvedValue({ decision: "reject", feedback: "not detailed enough" });
    const github = fakeGithub();

    const result = await runPipeline({ issue, repoDir: "/tmp/repo", github, push: true });

    expect(result.status).toBe("escalated-specs");
    expect(reviewSpecs).toHaveBeenCalledTimes(3);
    expect(createBranch).not.toHaveBeenCalled();
    expect(github.postComment).toHaveBeenCalledTimes(1);
  });

  it("pushes when the design is approved and QA passes on the first attempt", async () => {
    reviewSpecs.mockResolvedValue({ decision: "approve", feedback: "" });
    runCoding.mockResolvedValue("implemented");
    runQa.mockResolvedValue({ verdict: "pass", summary: "all good" });
    const github = fakeGithub();

    const result = await runPipeline({ issue, repoDir: "/tmp/repo", github, push: true });

    expect(result.status).toBe("pushed");
    expect(result.branchName).toBe("ai/issue-1-test");
    expect(runCoding).toHaveBeenCalledTimes(1);
    expect(runQa).toHaveBeenCalledTimes(1);
    expect(commitAndPush).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: "ai/issue-1-test", push: true }),
    );
  });

  it("escalates but still pushes a WIP branch when QA never passes", async () => {
    reviewSpecs.mockResolvedValue({ decision: "approve", feedback: "" });
    runCoding.mockResolvedValue("implemented");
    runQa.mockResolvedValue({ verdict: "fail", summary: "tests still failing", failedChecks: ["npm test"] });
    const github = fakeGithub();

    const result = await runPipeline({ issue, repoDir: "/tmp/repo", github, push: true });

    expect(result.status).toBe("escalated-qa");
    expect(runQa).toHaveBeenCalledTimes(3);
    expect(commitAndPush).toHaveBeenCalledTimes(1);
    expect(github.postComment).toHaveBeenCalledTimes(1);
  });
});
