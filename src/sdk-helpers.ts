import { query, type Options } from "@anthropic-ai/claude-agent-sdk";

export interface TextRunResult {
  ok: boolean;
  text?: string;
  error?: string;
}

export async function runTextQuery(prompt: string, options: Options): Promise<TextRunResult> {
  try {
    for await (const message of query({ prompt, options })) {
      if (message.type === "result") {
        if (message.subtype === "success") {
          return { ok: true, text: message.result };
        }
        return { ok: false, error: `stopped: ${message.subtype}` };
      }
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

export interface StructuredRunResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export async function runStructuredQuery<T>(
  prompt: string,
  options: Options,
  schema: Record<string, unknown>,
): Promise<StructuredRunResult<T>> {
  try {
    for await (const message of query({
      prompt,
      options: { ...options, outputFormat: { type: "json_schema", schema } },
    })) {
      if (message.type === "result") {
        if (message.subtype === "success" && message.structured_output) {
          return { ok: true, data: message.structured_output as T };
        }
        if (message.subtype === "error_max_structured_output_retries") {
          return { ok: false, error: "could not produce valid structured output" };
        }
        // Fail-closed: a "success" result with no structured_output is treated
        // as a failure too (documented SDK edge case), not a silent pass.
        return { ok: false, error: `run ended without structured output: ${message.subtype}` };
      }
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
