import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";
import { recordUsage, usageOfResult } from "./token-usage.js";

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
    for await (const message of query({ prompt, options })) {
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
