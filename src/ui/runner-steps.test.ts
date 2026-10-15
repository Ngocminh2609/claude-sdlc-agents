import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PipelineRunner, type RunState } from "./runner.js";
import type { MindMapNode } from "./mind-map.js";

/**
 * The step events end to end: a stand-in `bin/aidev.js` prints the lines the
 * CLI prints, and the real runner turns them into the state and mind map the
 * browser gets. Nothing here calls a model.
 */

let base: string;

const LINES = [
  { type: "budget", capUsd: 5 },
  { type: "progress", message: "4 task(s) to implement" },
  { type: "step", phase: "plan", group: "coding", items: [{ id: "T1", label: "Login API" }, { id: "T2", label: "Login page" }] },
  { type: "progress", message: "Build check: baseline — 1 command(s) on the code before the next task" },
  { type: "step", step: "gate:baseline", phase: "start" },
  { type: "step", step: "gate:baseline", phase: "end", ok: true },
  { type: "progress", message: "Coding: T1 (1/2)" },
  { type: "step", step: "coding:T1", phase: "start" },
  { type: "step", step: "coding:T1", phase: "turn", turns: 1, maxTurns: 60 },
  { type: "step", step: "coding:T1", phase: "turn", turns: 2, maxTurns: 60, note: "repeat" },
  { type: "step", step: "coding:T1", phase: "end", ok: true },
  { type: "step", step: "gate:T1", phase: "start" },
  { type: "step", step: "gate:T1", phase: "end", ok: false },
  { type: "progress", message: "Build check: fail — T1" },
  { type: "finished", status: "errored", message: "Build check failed after task T1" },
];

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "aidev-runner-steps-"));
  await mkdir(path.join(base, "bin"), { recursive: true });
  await mkdir(path.join(base, "project"), { recursive: true });
  await writeFile(path.join(base, "spec.md"), "# Spec\n");
  await writeFile(
    path.join(base, "bin", "aidev.js"),
    `for (const line of ${JSON.stringify(LINES)}) process.stdout.write(JSON.stringify(line) + "\\n");\n`,
  );
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

function finished(runner: PipelineRunner): Promise<RunState & { mindMap: MindMapNode }> {
  return new Promise((resolve) => {
    runner.subscribe((event) => {
      if (event.type === "state" && event.state.status !== "running" && event.state.finishedAt) {
        resolve(runner.getState());
      }
    });
  });
}

describe("PipelineRunner — step events", () => {
  it("turns the CLI's step events into steps, a plan, the budget and the mind map", async () => {
    const runner = new PipelineRunner(base);
    const done = finished(runner);
    runner.start({
      mode: "feature",
      projectPath: path.join(base, "project"),
      specPath: path.join(base, "spec.md"),
      dbMode: "none",
      maxRunUsd: 5,
    });
    const state = await done;

    expect(state.budgetCapUsd).toBe(5);
    expect(state.plan.coding?.map((item) => item.id)).toEqual(["T1", "T2"]);
    expect(state.steps["coding:T1"]).toEqual({
      stage: "coding",
      status: "done",
      turns: 2,
      maxTurns: 60,
      notes: { repeat: 1, blocked: 0, softCap: 0 },
    });
    expect(state.steps["gate:T1"].status).toBe("failed");

    const coding = state.mindMap.children.find((node) => node.id === "coding");
    expect(coding?.status).toBe("failed");
    expect(coding?.children.map((node) => [node.id, node.status, node.check])).toEqual([
      ["gate:baseline", "done", undefined],
      ["task:T1", "failed", "failed"],
      ["task:T2", "pending", "pending"],
    ]);
  });

  it("passes the spend cap to the CLI only when it is a positive number", async () => {
    const runner = new PipelineRunner(base);
    const done = finished(runner);
    runner.start({
      mode: "feature",
      projectPath: path.join(base, "project"),
      specPath: path.join(base, "spec.md"),
      dbMode: "none",
      maxRunUsd: -1,
    });
    await done;
    expect(runner.getLines()[0].text).not.toContain("--max-run-usd");
  });
});
