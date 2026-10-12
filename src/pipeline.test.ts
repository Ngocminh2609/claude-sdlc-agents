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
const canResumeSession = vi.fn();

vi.mock("./free-ports.js", () => ({ findFreePorts }));
vi.mock("./sdk-helpers.js", () => ({ canResumeSession }));
vi.mock("./checkpoint.js", () => ({
  fingerprint: (parts: unknown[]) => JSON.stringify(parts),
  progressKeptMessage: (reason: string) => `kept: ${reason}`,
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
const { claimStepSession } = await import("./step-session.js");

/** The session each mocked stage call was given, as the real query would claim it. */
function claimingSessions(mock: ReturnType<typeof vi.fn>, value: unknown): unknown[] {
  const seen: unknown[] = [];
  mock.mockImplementation(async () => {
    seen.push(claimStepSession());
    return value;
  });
  return seen;
}

const buildSaves = () =>
  saveCheckpoint.mock.calls.map(([, , , data]) => data).filter((data) => data.phase === "build");
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
  canResumeSession.mockResolvedValue(false);
  // Tests below swap these for session-recording implementations; never let one leak into the next.
  runCoding.mockReset();
  runE2eTest.mockReset();
});

const savedPlan = {
  phase: "build",
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

describe("runPipeline — design review with amendments", () => {
  it("builds the reviewer's amendments into the approved design every later stage sees", async () => {
    runSpecsArch.mockResolvedValue("the design");
    reviewSpecs.mockResolvedValue({
      decision: "approve",
      feedback: "sound, two small fixes",
      amendments: ["Add spring.sql.init.mode: always to application.yml", "Normalize blank category to null"],
    });
    runCoding.mockResolvedValue("implemented");
    runE2eTest.mockResolvedValue({ verdict: "pass", summary: "all good" });
    const progress: string[] = [];

    await runPipeline({ spec, onProgress: (message) => progress.push(message) });

    expect(reviewSpecs).toHaveBeenCalledTimes(1); // no redesign round spent on small fixes
    const approved = breakDownTasks.mock.calls[0][1] as string;
    expect(approved).toContain("the design");
    expect(approved).toContain("spring.sql.init.mode: always");
    expect(approved).toContain("Normalize blank category to null");
    expect(runCoding.mock.calls[0][0].approvedProposal).toBe(approved);
    expect(runE2eTest.mock.calls[0][1]).toBe(approved);
    expect(progress).toContain("Orchestrator review: approved with 2 amendment(s) for the coding stage");
  });

  it("passes a plain approval through unchanged", async () => {
    runSpecsArch.mockResolvedValue("the design");
    reviewSpecs.mockResolvedValue({ decision: "approve", feedback: "" });
    runCoding.mockResolvedValue("implemented");
    runE2eTest.mockResolvedValue({ verdict: "pass", summary: "all good" });

    await runPipeline({ spec });

    expect(breakDownTasks.mock.calls[0][1]).toBe("the design");
  });
});

describe("runPipeline — project map", () => {
  it("reuses saved conventions without a scan, and records the files each task really wrote for the next ones", async () => {
    const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { loadProjectMemory, manifestKeyOf } = await import("./project-memory.js");
    const { refreshIndexesForRun } = await import("./project-index.js");
    const base = await mkdtemp(path.join(tmpdir(), "aidev-map-"));
    // Never the real runs/: both the index and the map go to the temp folder.
    process.env.AIDEV_MEMORY_DIR = path.join(base, "memory");
    process.env.AIDEV_INDEX_DIR = path.join(base, "index");
    try {
      const project = path.join(base, "app");
      await mkdir(path.join(project, "src"), { recursive: true });
      await writeFile(path.join(project, "package.json"), "{}");
      const root = { role: "app" as const, path: project };
      const projectIndexes = await refreshIndexesForRun([project], () => {});
      const manifestKey = manifestKeyOf(projectIndexes, [root]) as string;
      const projectMemory = {
        version: 1,
        roots: [],
        conventions: { text: "saved conventions", manifestKey, savedAt: "2026-10-06T00:00:00Z" },
        features: [],
      };
      breakDownTasks.mockResolvedValue({
        tasks: [
          { id: "task-1", description: "first line\nlong details" },
          { id: "task-2", description: "second" },
        ],
      });
      reviewSpecs.mockResolvedValue({ decision: "approve", feedback: "" });
      runCoding.mockImplementation(async ({ task }) => {
        if (task.id === "task-1") await writeFile(path.join(project, "src", "rooms-api.ts"), "export function listRooms() {}\n");
        return "implemented";
      });
      runE2eTest.mockResolvedValue({ verdict: "pass", summary: "all good" });

      await runPipeline({
        spec: { ...spec, projectPath: project, targetRoots: [root], projectIndexes, projectMemory },
      });

      expect(inventoryProjectContext).not.toHaveBeenCalled();
      expect(runSpecsArch.mock.calls[0][4].conventions).toBe("saved conventions");
      // task-2 is told what task-1 wrote, with the names from the index.
      const earlier = runCoding.mock.calls[1][0].completedTasks[0];
      expect(earlier.files).toEqual(["app/src/rooms-api.ts | api-client | listRooms"]);
      const saved = await loadProjectMemory([root]);
      expect(saved.features[0]).toMatchObject({ status: "done" });
      expect(saved.features[0].tasks[0].files).toEqual(earlier.files);
    } finally {
      delete process.env.AIDEV_MEMORY_DIR;
      delete process.env.AIDEV_INDEX_DIR;
      await rm(base, { recursive: true, force: true });
    }
  });

  it("neither reads nor writes a project map when the run was not given one", async () => {
    reviewSpecs.mockResolvedValue({ decision: "approve", feedback: "" });
    runCoding.mockResolvedValue("implemented");
    runE2eTest.mockResolvedValue({ verdict: "pass", summary: "all good" });

    // AIDEV_MEMORY_DIR is unset here: any write would throw (see project-memory.ts) and fail the run.
    const result = await runPipeline({ spec });

    expect(result.status).toBe("done");
    expect(inventoryProjectContext).toHaveBeenCalled();
  });
});

describe("runPipeline — resuming a stopped design", () => {
  it("designs once, saves the rejected proposal and stops instead of looping", async () => {
    runSpecsArch.mockResolvedValueOnce("draft 1");
    reviewSpecs.mockResolvedValue({ decision: "reject", feedback: "needs work" });

    const result = await runPipeline({ spec });

    expect(result.status).toBe("escalated-specs");
    expect(runSpecsArch).toHaveBeenCalledTimes(1);
    const designSaves = saveCheckpoint.mock.calls
      .map(([, , , data]) => data)
      .filter((data) => data.phase === "design")
      .map((data) => [data.lastProposal, data.lastFeedback, data.draft ?? null, data.activeStep?.step ?? null]);
    // Every step is saved as running before its session starts, and its result
    // right after: the proposal before review, then the rejection.
    expect(designSaves).toEqual([
      [null, null, null, null],
      [null, null, null, "design:specs-arch"],
      [null, null, "draft 1", null],
      [null, null, "draft 1", "design:review"],
      ["draft 1", "needs work", null, null],
    ]);
    expect(result.message).toContain("revises this last proposal");
  });

  it("resumes by revising the last proposal with its feedback, without re-scanning", async () => {
    loadCheckpoint.mockResolvedValue({
      status: "found",
      savedAt: "2026-09-24T03:48:02Z",
      data: {
        phase: "design",
        inventory: null,
        projectContext: { conventions: "saved scan", relevantFiles: [], notes: "" },
        lastProposal: "revision 3",
        lastFeedback: "add a blank-param addendum",
      },
    });
    runSpecsArch.mockResolvedValue("revision 4");
    reviewSpecs.mockResolvedValue({ decision: "approve", feedback: "" });
    runCoding.mockResolvedValue("implemented");
    runE2eTest.mockResolvedValue({ verdict: "pass", summary: "all good" });

    await runPipeline({ spec });

    expect(inventoryProjectContext).not.toHaveBeenCalled();
    const [, priorProposal, feedback, , projectContext] = runSpecsArch.mock.calls[0];
    expect(priorProposal).toBe("revision 3");
    expect(feedback).toBe("add a blank-param addendum");
    expect(projectContext.conventions).toBe("saved scan");
    expect(breakDownTasks.mock.calls[0][1]).toBe("revision 4");
  });

  it("reviews a proposal written before the interruption instead of writing it again", async () => {
    loadCheckpoint.mockResolvedValue({
      status: "found",
      savedAt: "2026-10-06T04:00:00Z",
      data: { phase: "design", inventory: null, projectContext: null, lastProposal: null, lastFeedback: null, draft: "the draft" },
    });
    reviewSpecs.mockResolvedValue({ decision: "approve", feedback: "" });
    runCoding.mockResolvedValue("implemented");
    runE2eTest.mockResolvedValue({ verdict: "pass", summary: "all good" });

    await runPipeline({ spec });

    expect(runSpecsArch).not.toHaveBeenCalled();
    expect(reviewSpecs.mock.calls[0][1]).toBe("the draft");
    expect(breakDownTasks.mock.calls[0][1]).toBe("the draft");
  });

  it("goes straight to the breakdown when the design was approved before the interruption", async () => {
    loadCheckpoint.mockResolvedValue({
      status: "found",
      savedAt: "2026-10-06T04:00:00Z",
      data: {
        phase: "design",
        inventory: null,
        projectContext: null,
        lastProposal: null,
        lastFeedback: null,
        approved: "the approved design",
        activeStep: { step: "design:breakdown", sessionId: "breakdown-session" },
      },
    });
    canResumeSession.mockResolvedValue(true);
    const sessions = claimingSessions(breakDownTasks, { tasks: [{ id: "task-1", description: "do it" }] });
    runCoding.mockResolvedValue("implemented");
    runE2eTest.mockResolvedValue({ verdict: "pass", summary: "all good" });

    await runPipeline({ spec });

    expect(runSpecsArch).not.toHaveBeenCalled();
    expect(reviewSpecs).not.toHaveBeenCalled();
    expect(breakDownTasks.mock.calls[0][1]).toBe("the approved design");
    expect(sessions).toEqual([{ sessionId: "breakdown-session", resume: true }]);
  });

  it("resumes the project scan's own session when the run died during the scan", async () => {
    loadCheckpoint.mockResolvedValue({
      status: "found",
      savedAt: "2026-10-06T04:00:00Z",
      data: { phase: "scan", activeStep: { step: "scan:project-context", sessionId: "scan-session" } },
    });
    canResumeSession.mockResolvedValue(true);
    const sessions = claimingSessions(inventoryProjectContext, null);
    reviewSpecs.mockResolvedValue({ decision: "approve", feedback: "" });
    runCoding.mockResolvedValue("implemented");
    runE2eTest.mockResolvedValue({ verdict: "pass", summary: "all good" });

    await runPipeline({ spec });

    expect(sessions).toEqual([{ sessionId: "scan-session", resume: true }]);
    expect(runSpecsArch).toHaveBeenCalledTimes(1);
  });

  it("reuses the scan but writes a first proposal when it stopped before one existed", async () => {
    loadCheckpoint.mockResolvedValue({
      status: "found",
      savedAt: "2026-09-24T03:36:22Z",
      data: { phase: "design", inventory: null, projectContext: null, lastProposal: null, lastFeedback: null },
    });
    reviewSpecs.mockResolvedValue({ decision: "approve", feedback: "" });
    runCoding.mockResolvedValue("implemented");
    runE2eTest.mockResolvedValue({ verdict: "pass", summary: "all good" });

    await runPipeline({ spec });

    expect(inventoryProjectContext).not.toHaveBeenCalled();
    expect(runSpecsArch.mock.calls[0][1]).toBeNull();
  });
});

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

    const saves = buildSaves().map((data) => [data.completedTasks.length, data.activeStep?.step ?? null]);
    // Each step is saved as running before its session starts, and cleared once it finishes.
    expect(saves).toEqual([
      [0, null],
      [0, "coding:task-1"],
      [1, null],
      [1, "coding:task-2"],
      [2, null],
      [2, "e2e"],
      [2, null],
    ]);
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

  it("stops and keeps the saved progress when it was saved for different inputs", async () => {
    loadCheckpoint.mockResolvedValue({ status: "stale", savedAt: "2026-09-24T01:00:00Z" });

    const result = await runPipeline({ spec });

    expect(result.status).toBe("progress-kept");
    expect(result.message).toContain("different inputs");
    expect(inventoryProjectContext).not.toHaveBeenCalled();
    expect(runSpecsArch).not.toHaveBeenCalled();
    expect(runCoding).not.toHaveBeenCalled();
    expect(saveCheckpoint).not.toHaveBeenCalled();
    expect(clearCheckpoint).not.toHaveBeenCalled();
  });

  it("stops and keeps the saved progress when every file the finished tasks wrote has been deleted", async () => {
    loadCheckpoint.mockResolvedValue({
      status: "found",
      savedAt: "2026-09-24T01:00:00Z",
      data: {
        ...savedPlan,
        tasks: [{ id: "task-1", description: "a", targetFiles: ["definitely/not/here.ts"] }, savedPlan.tasks[1]],
      },
    });
    const progress: string[] = [];

    const result = await runPipeline({ spec, onProgress: (message) => progress.push(message) });

    expect(result.status).toBe("progress-kept");
    expect(runSpecsArch).not.toHaveBeenCalled();
    expect(saveCheckpoint).not.toHaveBeenCalled();
    expect(progress.some((line) => line.includes("are on disk any more"))).toBe(true);
  });

  it("runs each task in the session id saved for it before the session started", async () => {
    reviewSpecs.mockResolvedValue({ decision: "approve", feedback: "" });
    const sessions = claimingSessions(runCoding, "implemented");
    runE2eTest.mockResolvedValue({ verdict: "pass", summary: "all good" });

    await runPipeline({ spec });

    const saved = buildSaves().find((data) => data.activeStep?.step === "coding:task-1")?.activeStep;
    expect(sessions).toEqual([{ sessionId: saved.sessionId, resume: false }]);
  });

  it("resumes the interrupted task's own session when its transcript is still on disk", async () => {
    loadCheckpoint.mockResolvedValue({
      status: "found",
      savedAt: "2026-10-05T08:56:27Z",
      data: { ...savedPlan, activeStep: { step: "coding:task-2", sessionId: "0d8c97dc-9cd4-421d-932d-d6f40588305f" } },
    });
    canResumeSession.mockResolvedValue(true);
    const sessions = claimingSessions(runCoding, "implemented");
    runE2eTest.mockResolvedValue({ verdict: "pass", summary: "all good" });
    const progress: string[] = [];

    await runPipeline({ spec, onProgress: (message) => progress.push(message) });

    expect(canResumeSession).toHaveBeenCalledWith("0d8c97dc-9cd4-421d-932d-d6f40588305f");
    expect(sessions[0]).toEqual({ sessionId: "0d8c97dc-9cd4-421d-932d-d6f40588305f", resume: true });
    // The next task gets a session of its own, not a resumed one.
    expect(sessions[1]).toMatchObject({ resume: false });
    expect((sessions[1] as { sessionId: string }).sessionId).not.toBe("0d8c97dc-9cd4-421d-932d-d6f40588305f");
    expect(runCoding.mock.calls.map(([request]) => request.interrupted)).toEqual([false, false]);
    expect(progress.some((line) => line.includes("resuming the interrupted session"))).toBe(true);
  });

  it("starts a new session told to continue from the files on disk when the transcript is gone", async () => {
    loadCheckpoint.mockResolvedValue({
      status: "found",
      savedAt: "2026-10-05T08:56:27Z",
      data: { ...savedPlan, activeStep: { step: "coding:task-2", sessionId: "gone-session" } },
    });
    canResumeSession.mockResolvedValue(false);
    const sessions = claimingSessions(runCoding, "implemented");
    runE2eTest.mockResolvedValue({ verdict: "pass", summary: "all good" });

    await runPipeline({ spec });

    expect(sessions[0]).toMatchObject({ resume: false });
    expect((sessions[0] as { sessionId: string }).sessionId).not.toBe("gone-session");
    expect(runCoding.mock.calls.map(([request]) => [request.task.id, request.interrupted])).toEqual([
      ["task-2", true],
      ["task-3", false],
    ]);
  });

  it("keeps the interrupted step saved until it is picked up again", async () => {
    const active = { step: "coding:task-2", sessionId: "s-1" };
    loadCheckpoint.mockResolvedValue({
      status: "found",
      savedAt: "2026-10-05T08:56:27Z",
      data: { ...savedPlan, activeStep: active },
    });
    runCoding.mockResolvedValue("implemented");
    runE2eTest.mockResolvedValue({ verdict: "pass", summary: "all good" });

    await runPipeline({ spec, sqlRunner: undefined });

    // No save before task-2 may drop it: a second interruption there would lose the session.
    const firstSave = buildSaves()[0];
    expect(firstSave.activeStep?.step).toBe("coding:task-2");
  });

  it("resumes an E2E check that was interrupted, and starts the next one fresh once it finished", async () => {
    loadCheckpoint.mockResolvedValue({
      status: "found",
      savedAt: "2026-10-05T08:56:27Z",
      data: {
        ...savedPlan,
        completedTasks: savedPlan.tasks.map((task) => ({ ...task, summary: "done" })),
        activeStep: { step: "e2e", sessionId: "e2e-session" },
      },
    });
    canResumeSession.mockResolvedValue(true);
    const sessions = claimingSessions(runE2eTest, { verdict: "fail", summary: "broken" });

    await runPipeline({ spec });

    expect(sessions).toEqual([{ sessionId: "e2e-session", resume: true }]);
    expect(buildSaves().at(-1).activeStep).toBeUndefined();
  });

  it("resumes when the finished tasks named their files with the folder in front, or somewhere else", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const base = await mkdtemp(path.join(tmpdir(), "aidev-resume-"));
    const be = path.join(base, "BE");
    await mkdir(path.join(be, "src", "auth"), { recursive: true });
    await writeFile(path.join(be, "src", "auth", "Login.java"), "class Login {}");

    try {
      for (const targetFiles of [["BE/src/auth/Login.java"], ["backend/auth/Login.java"]]) {
        vi.clearAllMocks();
        loadCheckpoint.mockResolvedValue({
          status: "found",
          savedAt: "2026-10-05T06:52:27Z",
          data: { ...savedPlan, tasks: [{ id: "task-1", description: "a", targetFiles }, savedPlan.tasks[1]] },
        });
        runCoding.mockResolvedValue("implemented");
        runE2eTest.mockResolvedValue({ verdict: "pass", summary: "all good" });

        await runPipeline({ spec: { ...spec, projectPath: be, targetRoots: [{ role: "be", path: be }] } });

        expect(runSpecsArch).not.toHaveBeenCalled();
        expect(runCoding.mock.calls[0][0].task.id).toBe("task-2");
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("runPipeline", () => {
  it("escalates when the orchestrator never approves the proposal", async () => {
    reviewSpecs.mockResolvedValue({ decision: "reject", feedback: "not detailed enough" });

    const result = await runPipeline({ spec });

    expect(result.status).toBe("escalated-specs");
    expect(reviewSpecs).toHaveBeenCalledTimes(1);
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

  it("hands the E2E stage a fresh set of free ports, and none to coding, which does not start the app", async () => {
    reviewSpecs.mockResolvedValue({ decision: "approve", feedback: "" });
    runCoding.mockResolvedValue("implemented");
    runE2eTest.mockResolvedValue({ verdict: "pass", summary: "all good" });

    await runPipeline({ spec });

    expect(runCoding.mock.calls[0][0].runtimePorts).toBeUndefined();
    expect(runE2eTest.mock.calls[0][3]).toEqual([50001, 50002, 50003]);
    expect(findFreePorts).toHaveBeenCalledTimes(1);
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

describe("runPipeline — database scripts", () => {
  it("applies the scripts a task wrote right after that task, before the next one and before E2E", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const sqlDir = await mkdtemp(path.join(tmpdir(), "aidev-pipeline-sql-"));
    await writeFile(path.join(sqlDir, "00-existing.sql"), "CREATE TABLE before_run(id int);");

    const events: string[] = [];
    const runner = {
      runScript: vi.fn(async (sql: string) => void events.push(`db: ${sql}`)),
      close: vi.fn(async () => {}),
    };
    reviewSpecs.mockResolvedValue({ decision: "approve", feedback: "" });
    breakDownTasks.mockResolvedValue({
      tasks: [
        { id: "task-1", description: "schema" },
        { id: "task-2", description: "api" },
      ],
    });
    runCoding.mockImplementation(async ({ task }: { task: { id: string } }) => {
      events.push(`code: ${task.id}`);
      if (task.id === "task-1") await writeFile(path.join(sqlDir, "01-unit.sql"), "CREATE TABLE unit(id int);");
      return "done";
    });
    runE2eTest.mockImplementation(async () => {
      events.push("e2e");
      return { verdict: "pass", summary: "ok" };
    });

    try {
      const result = await runPipeline({
        spec: {
          ...spec,
          database: { dialect: "postgresql", description: "PostgreSQL at db/app", scriptsDir: sqlDir },
        },
        sqlRunner: runner,
      });

      expect(result.status).toBe("done");
      // The script that was there before the run never runs; the new one runs once, right after task-1.
      expect(events).toEqual(["code: task-1", "db: CREATE TABLE unit(id int);", "code: task-2", "e2e"]);
      const lastSave = saveCheckpoint.mock.calls.at(-1)?.[3];
      expect(Object.keys(lastSave.sqlScripts.applied)).toEqual(["01-unit.sql"]);
      expect(Object.keys(lastSave.sqlScripts.baseline)).toEqual(["00-existing.sql"]);
    } finally {
      await rm(sqlDir, { recursive: true, force: true });
    }
  });
});
