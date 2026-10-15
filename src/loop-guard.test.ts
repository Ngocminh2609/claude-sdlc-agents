import { afterEach, describe, expect, it } from "vitest";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { headAndTail, loopGuardHooks, loopLimitsFor, pruneBashOutput } from "./loop-guard.js";
import { onStepActivity, resetStepActivity, withStepActivity, type StepReport } from "./step-activity.js";

const limits = loopLimitsFor(10, { repeatWarn: 3, repeatBlock: 5, softCapRatio: 0.8, maxBashOutputChars: 100 });

type Hooks = ReturnType<typeof loopGuardHooks>;

async function fire(hooks: Hooks, event: "PreToolUse" | "PostToolUse" | "PostToolBatch", input: Record<string, unknown>) {
  const callback = hooks[event]?.[0].hooks[0];
  if (!callback) throw new Error(`no ${event} hook`);
  const base = { session_id: "s", transcript_path: "t", cwd: "c", hook_event_name: event };
  return callback({ ...base, ...input } as HookInput, "tool-use-id", { signal: new AbortController().signal });
}

const bash = (command: string, stdout = "ok") => ({
  tool_name: "Bash",
  tool_input: { command },
  tool_response: { stdout, stderr: "", interrupted: false, isImage: false },
  tool_use_id: "id",
});

afterEach(() => resetStepActivity());

describe("loopLimitsFor", () => {
  it("puts the soft cap at the configured share of the stage's turns", () => {
    expect(limits.softCapTurns).toBe(8);
    expect(loopLimitsFor(1, { repeatWarn: 3, repeatBlock: 5, softCapRatio: 0.8, maxBashOutputChars: 1 }).softCapTurns).toBe(1);
  });
});

describe("loopGuardHooks — repeats", () => {
  it("warns on the third identical call with the same result, then refuses it from the fifth", async () => {
    const hooks = loopGuardHooks(limits);
    const outputs = [];
    for (let i = 0; i < 5; i++) outputs.push(await fire(hooks, "PostToolUse", bash("npm run lint")));

    expect(outputs[1]).toEqual({});
    expect(JSON.stringify(outputs[2])).toContain("Loop warning");
    const pre = await fire(hooks, "PreToolUse", { tool_name: "Bash", tool_input: { command: "npm run lint" }, tool_use_id: "x" });
    expect(pre).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });

  it("does not count the same command as a repeat when its output changed", async () => {
    const hooks = loopGuardHooks(limits);
    for (let i = 0; i < 5; i++) {
      const output = await fire(hooks, "PostToolUse", bash("mvn -q compile", `error ${i}`));
      expect(output).toEqual({});
    }
    expect(await fire(hooks, "PreToolUse", { tool_name: "Bash", tool_input: { command: "mvn -q compile" }, tool_use_id: "x" })).toEqual({});
  });

  it("gives every session its own count", async () => {
    const first = loopGuardHooks(limits);
    for (let i = 0; i < 4; i++) await fire(first, "PostToolUse", bash("ls"));
    expect(await fire(loopGuardHooks(limits), "PostToolUse", bash("ls"))).toEqual({});
  });
});

describe("loopGuardHooks — soft cap and reports", () => {
  it("tells the agent to wrap up once, at the soft cap, and reports every turn of the active step", async () => {
    const hooks = loopGuardHooks(limits);
    const reports: StepReport[] = [];
    onStepActivity((report) => reports.push(report));
    const nudges: unknown[] = [];

    await withStepActivity("coding:T1", async () => {
      for (let i = 0; i < 9; i++) nudges.push(await fire(hooks, "PostToolBatch", { tool_calls: [] }));
    });

    expect(nudges.filter((output) => JSON.stringify(output).includes("Turn budget"))).toHaveLength(1);
    expect(JSON.stringify(nudges[7])).toContain("8 of 10 turns used");
    const turns = reports.filter((report) => report.phase === "turn");
    expect(turns).toHaveLength(9);
    expect(turns[7]).toMatchObject({ step: "coding:T1", turns: 8, maxTurns: 10, note: "soft-cap" });
    expect(reports[0]).toEqual({ step: "coding:T1", phase: "start" });
    expect(reports.at(-1)).toEqual({ step: "coding:T1", phase: "end", ok: true });
  });

  it("reports a repeat warning on the turn it happened", async () => {
    const hooks = loopGuardHooks(limits);
    const reports: StepReport[] = [];
    onStepActivity((report) => reports.push(report));

    await withStepActivity("e2e", async () => {
      for (let i = 0; i < 3; i++) await fire(hooks, "PostToolUse", bash("npx playwright test"));
      await fire(hooks, "PostToolBatch", { tool_calls: [] });
    });

    expect(reports).toContainEqual({ step: "e2e", phase: "turn", turns: 1, maxTurns: 10, note: "repeat" });
  });
});

describe("Bash output pruning", () => {
  it("cuts long stdout/stderr to head and tail, keeping the result's own shape", async () => {
    const long = `${"a".repeat(80)}${"m".repeat(500)}${"z".repeat(80)}`;
    const output = await fire(loopGuardHooks(limits), "PostToolUse", bash("mvn compile", long));
    const pruned = (output as { hookSpecificOutput: { updatedToolOutput: Record<string, unknown> } }).hookSpecificOutput
      .updatedToolOutput;

    expect(Object.keys(pruned)).toEqual(["stdout", "stderr", "interrupted", "isImage"]);
    expect(String(pruned.stdout).startsWith("a".repeat(50))).toBe(true);
    expect(String(pruned.stdout).endsWith("z".repeat(50))).toBe(true);
    expect(String(pruned.stdout)).toContain("characters cut by the pipeline");
  });

  it("leaves short output and other tools alone", () => {
    expect(pruneBashOutput({ stdout: "short", stderr: "" }, 100)).toBeUndefined();
    expect(pruneBashOutput("not an object", 100)).toBeUndefined();
    expect(headAndTail("0123456789", 4)).toMatch(/^01\n.*\n89$/s);
  });
});
