import { describe, expect, it } from "vitest";
import { buildMindMap, type MindMapNode } from "./mind-map.js";
import type { RunState, StepState } from "./runner.js";
import { emptyUsage } from "../token-usage.js";

const notes = () => ({ repeat: 0, blocked: 0, softCap: 0 });

function step(stage: StepState["stage"], status: StepState["status"], extra: Partial<StepState> = {}): StepState {
  return { stage, status, notes: notes(), ...extra };
}

function runState(overrides: Partial<RunState>): RunState {
  return {
    id: "r",
    status: "running",
    mode: "feature",
    startedAt: "2026-10-15T00:00:00Z",
    finishedAt: null,
    projectPath: "/p",
    specPath: "/p/spec.md",
    what: null,
    dbMode: "none",
    stage: null,
    stageDetail: null,
    completedStages: [],
    usage: emptyUsage(),
    stageUsage: {},
    setback: false,
    taskCount: null,
    finalMessage: null,
    logPath: null,
    logRunId: null,
    steps: {},
    plan: {},
    budgetCapUsd: null,
    sql: null,
    ...overrides,
  };
}

const find = (node: MindMapNode, id: string): MindMapNode => {
  if (node.id === id) return node;
  for (const child of node.children) {
    const hit = find(child, id);
    if (hit) return hit;
  }
  return undefined as unknown as MindMapNode;
};

const midCoding = runState({
  stage: "coding",
  completedStages: ["inventory", "specs-arch", "review", "tasks"],
  plan: {
    coding: [
      { id: "T1", label: "Login API" },
      { id: "T2", label: "Login page" },
      { id: "T3", label: "Logout" },
    ],
  },
  steps: {
    "design:specs-arch": step("specs-arch", "done"),
    "gate:baseline": step("coding", "done"),
    "coding:T1": step("coding", "done", { turns: 20, maxTurns: 60 }),
    "gate:T1": step("coding", "done"),
    "coding:T2": step("coding", "active", { turns: 30, maxTurns: 60, notes: { repeat: 1, blocked: 0, softCap: 0 } }),
  },
});

describe("buildMindMap — a feature run in the middle of Coding", () => {
  const map = buildMindMap(midCoding);

  it("lays the stages of the run's own flow around the root", () => {
    expect(map.children.map((node) => node.id)).toEqual(["inventory", "specs-arch", "review", "tasks", "coding", "e2e"]);
    expect(find(map, "specs-arch")).toMatchObject({ status: "done", percent: 100 });
    expect(find(map, "e2e")).toMatchObject({ status: "pending", percent: 0 });
  });

  it("highlights the running stage and task, with the task's turns as an estimate", () => {
    expect(find(map, "coding").status).toBe("active");
    expect(find(map, "task:T2")).toMatchObject({
      status: "active",
      estimate: true,
      turns: 30,
      maxTurns: 60,
      check: "pending",
      // 50% of the turn cap, scaled to the code's share of the task.
      percent: 43,
      notes: { repeat: 1, blocked: 0, softCap: 0 },
    });
  });

  it("counts a task done only once its build check passed, and lists tasks not started at 0", () => {
    expect(find(map, "task:T1")).toMatchObject({ status: "done", percent: 100, check: "done", label: "Login API" });
    expect(find(map, "task:T3")).toMatchObject({ status: "pending", percent: 0 });
    expect(find(map, "gate:baseline")).toMatchObject({ status: "done", percent: 100 });
  });

  it("averages the parts into the stage and the run", () => {
    // baseline 100, T1 100, T2 43, T3 0
    expect(find(map, "coding").percent).toBe(61);
    // 4 stages done, coding 61, e2e 0
    expect(map.percent).toBe(77);
    expect(map.status).toBe("active");
  });
});

describe("buildMindMap — how runs end", () => {
  it("marks the task whose build check failed, and the stage the run stopped in", () => {
    const map = buildMindMap({
      ...midCoding,
      status: "errored",
      completedStages: [...midCoding.completedStages, "coding"],
      steps: {
        ...midCoding.steps,
        "coding:T2": step("coding", "done", { turns: 41, maxTurns: 60 }),
        "gate:T2": step("coding", "failed"),
      },
    });

    expect(find(map, "task:T2")).toMatchObject({ status: "failed", check: "failed" });
    expect(find(map, "coding").status).toBe("failed");
    expect(map.status).toBe("failed");
  });

  it("is 100 when the run is done", () => {
    const map = buildMindMap(
      runState({ status: "done", stage: "e2e", completedStages: ["inventory", "specs-arch", "review", "tasks", "coding", "e2e"] }),
    );
    expect(map.percent).toBe(100);
    expect(map.children.every((node) => node.status === "done")).toBe(true);
  });
});

describe("buildMindMap — measures it does not have", () => {
  it("shows a running plain-code check as running, without a number, and an agent step without turns at 0", () => {
    const map = buildMindMap(
      runState({
        stage: "coding",
        plan: { coding: [{ id: "T1", label: "x" }] },
        steps: { "gate:baseline": step("coding", "active") },
      }),
    );
    expect(find(map, "gate:baseline")).toMatchObject({ status: "active", percent: null, estimate: false });
    // baseline counted as half done, T1 not started.
    expect(find(map, "coding").percent).toBe(25);
  });

  it("never shows a running agent step as finished, even past its turn cap", () => {
    const map = buildMindMap(
      runState({ stage: "e2e", steps: { e2e: step("e2e", "active", { turns: 70, maxTurns: 60 }) } }),
    );
    expect(find(map, "e2e")).toMatchObject({ percent: 95, estimate: true, turns: 70 });
  });
});

describe("buildMindMap — clone runs", () => {
  it("lists every port group from the plan, and a stage's repeated steps as its children", () => {
    const map = buildMindMap(
      runState({
        mode: "clone",
        stage: "tests",
        completedStages: ["locate", "conventions", "mapping", "port", "coverage", "wiring", "build"],
        plan: { port: [{ id: "SQL", label: "SQL" }, { id: "BE:category", label: "BE:category" }] },
        steps: {
          "port:SQL": step("port", "done"),
          "port:BE:category": step("port", "done"),
          "verify:build:1": step("build", "done"),
          "verify:tests:1": step("tests", "done"),
          "verify:fix:1": step("tests", "active", { turns: 15, maxTurns: 60 }),
        },
      }),
    );

    expect(find(map, "port").children.map((node) => node.label)).toEqual(["SQL", "BE:category"]);
    expect(find(map, "tests").children.map((node) => node.id)).toEqual(["verify:tests:1", "verify:fix:1"]);
    expect(find(map, "verify:fix:1")).toMatchObject({ status: "active", percent: 25 });
    // A single step is the stage itself, not a child.
    expect(find(map, "build").children).toEqual([]);
  });
});
