import { getSessionInfo, query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";
import { recordUsage, usageOfResult } from "./token-usage.js";
import { claimStepSession } from "./step-session.js";
import { RUNTIME_PORTS_HEADER } from "./prompts/runtime-ports.js";

/**
 * Whether a stage session started by an earlier run can be resumed: its
 * transcript is on disk under the current working directory's project folder.
 *
 * The SDK writes the transcript as the session goes, so a session whose
 * process was killed (the machine shut down, the UI server stopped, a usage
 * limit) is still there and resumes with its whole conversation — verified by
 * killing a session mid-tool-call and resuming it.
 */
export async function canResumeSession(sessionId: string): Promise<boolean> {
  try {
    return (await getSessionInfo(sessionId, { dir: process.cwd() })) !== undefined;
  } catch {
    return false;
  }
}

export interface TextRunResult {
  ok: boolean;
  text?: string;
  error?: string;
}

/**
 * Whether the SDK itself flagged this outcome as an error, as opposed to
 * throwing.
 *
 * The account hitting its plan usage limit, an auth problem, a billing
 * error, or an outage mid-turn does not throw — per the SDK's own types, the
 * affected assistant message carries `error` (e.g. `"rate_limit"`,
 * `"authentication_failed"`), and the terminal `result` message can still
 * carry `subtype: "success"` while `is_error` is `true`: a success shape
 * whose `result` text is that notice, not real output from the task.
 *
 * Verified against a real failure, not a hypothetical one: during testing,
 * this session's own usage limit was hit mid-run, and the Coding stage's
 * returned "summary" was the literal text "You've hit your session limit …".
 * Both functions below accepted it as `{ ok: true, text: … }`, because
 * neither checked `is_error` on a `subtype: "success"` result — only the
 * subtype was checked. That text then flowed into the run log and the
 * pipeline's coding-attempt history as if the stage had genuinely reported on
 * its work.
 *
 * `is_error` on the terminal result message is what both functions act on;
 * it is the field the SDK sets specifically to distinguish this case.
 * `lastAssistantError`, tracked separately below, only sharpens the console
 * log for *why* — a per-turn flag on an assistant message is not confirmed to
 * always end the run, so it is not treated as its own abort signal.
 */
function isFlaggedError(message: SDKMessage): boolean {
  return message.type === "result" && message.is_error === true;
}

/** Built-in tools a stage reaches only through its `canUseTool` gate, never through `allowedTools`. */
const GATED_WRITE_TOOLS = ["Write", "Edit"];

/**
 * Stops a server the agent started with `run_in_background`. Without it the
 * agent falls back to hunting PIDs from Bash, which on Windows can miss the
 * real server (a java/node child of the shell) and leave it holding a port.
 */
const BACKGROUND_STOP_TOOL = "TaskStop";

/**
 * Cuts a stage's session down to what the stage itself declares.
 *
 * Left to SDK defaults, every session loads the operator's whole `~/.claude`:
 * their hooks, personal CLAUDE.md and rules, every user-level MCP server, the
 * skill and agent listings, and the schema of every built-in tool. On a real
 * feature run that was 30K+ tokens before the stage prompt, re-read on each of
 * ~200 Coding turns; a probe of the same query measured 32.8K tokens of context
 * by default against 7.7K with these options. None of it was meant for the
 * pipeline: stages get their skill catalog and conventions through their own
 * prompt sections.
 *
 * `tools` is the stage's `allowedTools` (pattern suffixes stripped), plus
 * Write/Edit when the stage gates writes through `canUseTool`, plus TaskStop
 * when it has Bash. A stage that sets `tools` or `settingSources` itself keeps
 * its own value.
 */
export function isolatedOptions(options: Options): Options {
  const declared = (options.allowedTools ?? []).map((tool) => tool.replace(/\(.*$/, ""));
  const gated = options.canUseTool ? GATED_WRITE_TOOLS : [];
  const stop = declared.includes("Bash") ? [BACKGROUND_STOP_TOOL] : [];
  return {
    settingSources: [],
    strictMcpConfig: true,
    tools: [...new Set([...declared, ...gated, ...stop])],
    ...options,
  };
}

/**
 * Sent in place of a stage's prompt when its interrupted session is resumed:
 * the original prompt is already in that session's history, so only the new
 * situation needs saying. Ports are the one input that must be fresh — the old
 * ones may be taken now — so the new prompt's port block is carried over.
 */
export function resumePrompt(originalPrompt: string): string {
  const lines = originalPrompt.split("\n");
  const start = lines.indexOf(RUNTIME_PORTS_HEADER);
  const end = start === -1 ? -1 : lines.indexOf("", start);
  const ports = start === -1 ? [] : ["", ...lines.slice(start, end === -1 ? undefined : end)];
  return [
    "--- Resumed after an interruption ---",
    "This session was interrupted before you finished (the machine or the pipeline was shut down, or",
    "a usage limit was hit). Everything above is still your own work and context. Any server or",
    "background process you had started is no longer running. Check the current state of anything",
    "you were changing, then continue the same job from where you stopped — do not start it over —",
    "and finish with exactly the output you were asked for.",
    ...ports,
  ].join("\n");
}

/**
 * Ties a query to its pipeline step's saved session (see `step-session.ts`):
 * a new step's session starts under the id already saved in the checkpoint; an
 * interrupted step's session is resumed with `resumePrompt`.
 */
function withStepSession(prompt: string, options: Options): { prompt: string; options: Options } {
  const session = claimStepSession();
  if (!session) return { prompt, options };
  if (session.resume) return { prompt: resumePrompt(prompt), options: { ...options, resume: session.sessionId } };
  return { prompt, options: { ...options, sessionId: session.sessionId } };
}

/**
 * Runs the message loop shared by both query shapes below: watches for the
 * SDK's own error signal on every message (see `isFlaggedError`), not just on
 * the terminal one, and hands the terminal result to `onResult` once seen.
 *
 * Extracted because both functions need the identical two things — the error
 * check and the console-log detail for it — and a second near-identical
 * fail-closed branch is exactly the duplication this file's own shared rules
 * (`prompts/code-quality.ts`) ask a stage's code to avoid.
 */
async function runQueryLoop<T>(
  prompt: string,
  options: Options,
  onResult: (
    message: Extract<SDKMessage, { type: "result" }>,
  ) => { ok: true; value: T } | { ok: false; error: string; subtype?: string },
): Promise<{ ok: true; value: T } | { ok: false; error: string; subtype?: string }> {
  let lastAssistantError: string | undefined;

  // A unit test that forgets to mock a stage must fail, not start a real agent.
  // It happened: unmocked clone stages ran real sessions from vitest, which
  // left Git Bash `find /` scans running for hours after the tests ended and
  // filled the kernel's paged pool with millions of handles.
  if (process.env.VITEST && !("mock" in (query as object))) {
    throw new Error("A real Agent SDK call was attempted inside a unit test — mock the stage that made it.");
  }

  try {
    const step = withStepSession(prompt, options);
    for await (const message of query({ prompt: step.prompt, options: isolatedOptions(step.options) })) {
      if (message.type === "assistant" && message.error) {
        lastAssistantError = message.error;
      }

      if (message.type !== "result") continue;

      // Counted before the error check: a failed call still spent its tokens.
      recordUsage(usageOfResult(message));

      if (isFlaggedError(message)) {
        // Detail for the console only — see the existing rule below about
        // never letting raw SDK/exception text reach the caller-facing error.
        console.error(
          "SDK query() flagged is_error on a result message.",
          lastAssistantError ? `Last assistant-reported error: ${lastAssistantError}.` : "",
          `subtype: ${message.subtype}`,
          // The notice itself is what says *why* — e.g. "Claude Code 2.1.245 does not support this
          // model", which "unknown" above hid on a real run. Console only, like the rest of this line.
          message.subtype === "success" && message.result ? `\nResult text: ${message.result.slice(0, 500)}` : "",
        );
        // The reason is the SDK's own code ("rate_limit", "error_max_turns",
        // ...), not raw exception text, so it is safe to surface — and it is
        // the one word that tells a user whether to wait, re-auth, or fix code.
        return {
          ok: false,
          error: `SDK reported an error mid-run: ${lastAssistantError ?? message.subtype} (see console output above for details)`,
          // The raw subtype, not the interpolated text above — so a caller
          // (see runStructuredQuery's retry) can act on it without parsing a
          // human-readable message that also embeds the assistant's own error.
          subtype: message.subtype,
        };
      }

      return onResult(message);
    }
    return { ok: false, error: "no result message received" };
  } catch (error) {
    // Log full detail to the console only — the message below can end up in
    // the pipeline's final report, so it must never carry raw exception text
    // (stack frames, paths, etc.).
    console.error("SDK query() threw:", error);
    return { ok: false, error: "SDK call failed (see console output above for details)" };
  }
}

export async function runTextQuery(prompt: string, options: Options): Promise<TextRunResult> {
  const result = await runQueryLoop<string>(prompt, options, (message) => {
    if (message.subtype === "success") {
      return { ok: true, value: message.result };
    }
    return { ok: false, error: `stopped: ${message.subtype}` };
  });
  return result.ok ? { ok: true, text: result.value } : { ok: false, error: result.error };
}

export interface StructuredRunResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

/**
 * The one subtype this file retries on its own — see `config.maxStructuredOutputRetries`
 * for why it, and only it, gets a bounded automatic retry.
 */
const RETRYABLE_SUBTYPE = "error_max_structured_output_retries";

export async function runStructuredQuery<T>(
  prompt: string,
  options: Options,
  schema: Record<string, unknown>,
  maxRetries: number = config.maxStructuredOutputRetries,
): Promise<StructuredRunResult<T>> {
  const queryOptions: Options = { ...options, outputFormat: { type: "json_schema", schema } };
  const onResult = (message: Extract<SDKMessage, { type: "result" }>) => {
    if (message.subtype === "success" && message.structured_output) {
      return { ok: true as const, value: message.structured_output as T };
    }
    if (message.subtype === RETRYABLE_SUBTYPE) {
      return { ok: false as const, error: "could not produce valid structured output", subtype: message.subtype };
    }
    // Fail-closed: a "success" result with no structured_output is treated
    // as a failure too (documented SDK edge case), not a silent pass.
    return { ok: false as const, error: `run ended without structured output: ${message.subtype}`, subtype: message.subtype };
  };

  let last: { ok: false; error: string; subtype?: string } | undefined;
  for (let attempt = 1; attempt <= 1 + maxRetries; attempt++) {
    const result = await runQueryLoop<T>(prompt, queryOptions, onResult);
    if (result.ok) return { ok: true, data: result.value };
    if (result.subtype !== RETRYABLE_SUBTYPE || attempt > maxRetries) return { ok: false, error: result.error };
    last = result;
    // A retry here is a brand-new session (see config.ts) — worth a line in
    // the console the same way the is_error branch already logs its detail.
    console.error(`Structured output retry ${attempt}/${maxRetries} after ${RETRYABLE_SUBTYPE}.`);
  }
  // Unreachable given the loop bounds above; satisfies the type checker and
  // fails closed rather than returning undefined if that ever changes.
  return { ok: false, error: last?.error ?? "could not produce valid structured output" };
}
