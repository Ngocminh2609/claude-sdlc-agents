import { createHash } from "node:crypto";
import type { HookCallbackMatcher, HookEvent, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { activeStepName, reportStep, type StepNote } from "./step-activity.js";

/**
 * Plain-code guards on one agent session's own loop, attached to every stage
 * by `isolatedOptions` (`sdk-helpers.ts`), so no stage has to opt in:
 *
 * - Repeat detection. The same tool call returning the same result again is a
 *   loop, not progress: the agent is told so at `repeatWarn`, and from
 *   `repeatBlock` that exact call is refused. Keyed on input AND output, so
 *   re-running a build after an edit (same command, new output) is not a repeat.
 * - Soft cap. Once `softCapTurns` of the stage's `maxTurns` are used, the agent
 *   is told to stop exploring and finish. Without it a session that runs out
 *   of turns ends with `error_max_turns` and no answer at all.
 * - Output pruning. A Bash result longer than `maxBashOutputChars` is cut to
 *   its head and tail before the model sees it — it would otherwise be re-sent
 *   on every later turn of the session. Head and tail are kept because build
 *   tools print the command at the top and the errors at the bottom.
 *
 * Verified against the real SDK with Haiku (2026-10-15): hooks passed in
 * `Options` fire under `settingSources: []`; PreToolUse `deny` and PostToolUse
 * `additionalContext` reach the model; `updatedToolOutput` replaces a Bash
 * result only when given Bash's own object shape (`{ stdout, stderr, ... }`) —
 * a plain string was silently ignored, hence the field-wise cut below.
 *
 * Nothing here calls a model or retries anything: a guard can only warn, refuse
 * one call, or shorten one output.
 */

/** Opens every message the guard sends, so the agent can tell it from tool output. */
export const GUARD_TAG = "[aidev pipeline]";

/**
 * Appended to a guarded stage's system prompt. Needed, not decorative: on a
 * real probe (Haiku, 2026-10-15) the agent received the guard's warnings and
 * ignored them, saying it "did not verify where that text came from" — it
 * treated the pipeline's own messages like text injected into a tool result.
 */
export const GUARD_NOTICE = `Messages starting with "${GUARD_TAG}" that appear next to a tool result or a refused call come from
the pipeline running you, not from the tool, the project or any file: a loop warning, a refused repeat of
the same call, or a turn-budget notice. Follow them.`;

export interface LoopGuardLimits {
  /** Same call, same result this many times: the agent is warned. */
  repeatWarn: number;
  /** ...this many times: that call is refused from then on. */
  repeatBlock: number;
  /** Turns after which the agent is told to wrap up. */
  softCapTurns: number;
  maxTurns: number;
  /** Bash stdout/stderr longer than this is cut to head + tail. */
  maxBashOutputChars: number;
}

type Hooks = Partial<Record<HookEvent, HookCallbackMatcher[]>>;

/** Fresh state per call: one guard per agent session. */
export function loopGuardHooks(limits: LoopGuardLimits): Hooks {
  const seen = new Map<string, number>();
  const blocked = new Set<string>();
  let turns = 0;
  const notesForTurn: StepNote[] = [];

  const note = (kind: StepNote): void => {
    notesForTurn.push(kind);
  };

  return {
    PreToolUse: [
      {
        hooks: [
          async (input): Promise<HookJSONOutput> => {
            if (input.hook_event_name !== "PreToolUse") return {};
            if (!blocked.has(hashOf(input.tool_name, input.tool_input))) return {};
            note("blocked");
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: `${GUARD_TAG} This exact ${input.tool_name} call has already run ${limits.repeatBlock} times with the same result, so it is refused. Do something different: change the input, read the error, or report what is blocking you.`,
              },
            };
          },
        ],
      },
    ],
    PostToolUse: [
      {
        hooks: [
          async (input): Promise<HookJSONOutput> => {
            if (input.hook_event_name !== "PostToolUse") return {};
            const callKey = hashOf(input.tool_name, input.tool_input);
            const resultKey = hashOf(callKey, input.tool_response);
            const count = (seen.get(resultKey) ?? 0) + 1;
            seen.set(resultKey, count);
            if (count >= limits.repeatBlock) blocked.add(callKey);

            const context =
              count >= limits.repeatWarn
                ? `${GUARD_TAG} Loop warning: this ${input.tool_name} call returned the same result ${count} times. Repeating it will not change anything — change approach.`
                : undefined;
            if (context) note("repeat");
            const pruned = input.tool_name === "Bash" ? pruneBashOutput(input.tool_response, limits.maxBashOutputChars) : undefined;
            if (!context && pruned === undefined) return {};
            return {
              hookSpecificOutput: {
                hookEventName: "PostToolUse",
                ...(context ? { additionalContext: context } : {}),
                ...(pruned !== undefined ? { updatedToolOutput: pruned } : {}),
              },
            };
          },
        ],
      },
    ],
    // One batch = the tool calls of one assistant turn: the unit `maxTurns` counts.
    PostToolBatch: [
      {
        hooks: [
          async (input): Promise<HookJSONOutput> => {
            if (input.hook_event_name !== "PostToolBatch") return {};
            turns++;
            const softCap = turns === limits.softCapTurns;
            if (softCap) note("soft-cap");
            report(turns, limits.maxTurns, notesForTurn.splice(0));
            if (!softCap) return {};
            return {
              hookSpecificOutput: {
                hookEventName: "PostToolBatch",
                additionalContext: `${GUARD_TAG} Turn budget: ${turns} of ${limits.maxTurns} turns used. Stop exploring now — finish the task with what you have and give your final answer within the next few turns.`,
              },
            };
          },
        ],
      },
    ],
  };
}

/** The guard's limits for a stage, from its own `maxTurns`. */
export function loopLimitsFor(
  maxTurns: number,
  settings: { repeatWarn: number; repeatBlock: number; softCapRatio: number; maxBashOutputChars: number },
): LoopGuardLimits {
  return {
    repeatWarn: settings.repeatWarn,
    repeatBlock: settings.repeatBlock,
    softCapTurns: Math.max(1, Math.floor(maxTurns * settings.softCapRatio)),
    maxTurns,
    maxBashOutputChars: settings.maxBashOutputChars,
  };
}

/**
 * Bash's result with stdout/stderr cut to head + tail, or undefined when
 * nothing is long enough to cut. Keeps every other field: the SDK only accepts
 * a replacement in the tool's own shape.
 */
export function pruneBashOutput(response: unknown, maxChars: number): Record<string, unknown> | undefined {
  if (typeof response !== "object" || response === null) return undefined;
  const fields = response as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = { ...fields };
  for (const key of ["stdout", "stderr"]) {
    const value = fields[key];
    if (typeof value === "string" && value.length > maxChars) {
      next[key] = headAndTail(value, maxChars);
      changed = true;
    }
  }
  return changed ? next : undefined;
}

export function headAndTail(text: string, maxChars: number): string {
  const half = Math.floor(maxChars / 2);
  const cut = text.length - half * 2;
  return `${text.slice(0, half)}\n… [${cut} characters cut by the pipeline — the start and the end are kept] …\n${text.slice(-half)}`;
}

function report(turns: number, maxTurns: number, notes: StepNote[]): void {
  const step = activeStepName();
  if (!step) return;
  if (!notes.length) reportStep({ step, phase: "turn", turns, maxTurns });
  for (const kind of notes) reportStep({ step, phase: "turn", turns, maxTurns, note: kind });
}

function hashOf(...parts: unknown[]): string {
  return createHash("sha1").update(JSON.stringify(parts)).digest("hex");
}
