import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query }));

const { runTextQuery, runStructuredQuery, isolatedOptions, resumePrompt } = await import("./sdk-helpers.js");

// Only the newer tests below assert call counts, but a leftover implementation
// or queued mockImplementationOnce from an earlier test would otherwise still
// answer a later test's calls — reset before every test, not just for those.
beforeEach(() => {
  query.mockReset();
});

async function* messages(...msgs: unknown[]) {
  for (const m of msgs) yield m;
}

describe("runTextQuery", () => {
  it("returns the result text on a success message", async () => {
    query.mockReturnValue(messages({ type: "result", subtype: "success", result: "done" }));

    const result = await runTextQuery("prompt", {});

    expect(result).toEqual({ ok: true, text: "done" });
  });

  it("fails when the result subtype is not success", async () => {
    query.mockReturnValue(messages({ type: "result", subtype: "error_max_turns" }));

    const result = await runTextQuery("prompt", {});

    expect(result.ok).toBe(false);
    expect(result.error).toContain("error_max_turns");
  });

  it("sanitizes a thrown error instead of leaking its message", async () => {
    query.mockImplementation(() => {
      throw new Error("ECONNRESET at /home/runner/secret/path.ts:42");
    });

    const result = await runTextQuery("prompt", {});

    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("ECONNRESET");
    expect(result.error).not.toContain("secret/path.ts");
  });

  // Reproduces a failure observed for real: this session's own usage limit
  // was hit mid-run, and the SDK returned subtype "success" with is_error
  // true and the account's own limit notice as the "result" text — accepted
  // before this check existed.
  it("fails closed on subtype success when is_error is true, instead of returning the notice as real output", async () => {
    query.mockReturnValue(
      messages({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "You've hit your session limit · resets 1:40pm (Asia/Ho_Chi_Minh)",
      }),
    );

    const result = await runTextQuery("prompt", {});

    expect(result.ok).toBe(false);
    expect(result.text).toBeUndefined();
    expect(result.error).not.toContain("session limit");
  });

  it("still succeeds on subtype success when is_error is explicitly false", async () => {
    query.mockReturnValue(
      messages({ type: "result", subtype: "success", is_error: false, result: "done" }),
    );

    const result = await runTextQuery("prompt", {});

    expect(result).toEqual({ ok: true, text: "done" });
  });

  it("logs the assistant-reported error kind seen before the flagged result", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    query.mockReturnValue(
      messages(
        { type: "assistant", error: "rate_limit" },
        { type: "result", subtype: "success", is_error: true, result: "…" },
      ),
    );

    await runTextQuery("prompt", {});

    const logged = consoleError.mock.calls.flat().join(" ");
    expect(logged).toContain("rate_limit");
    consoleError.mockRestore();
  });
});

describe("runStructuredQuery", () => {
  it("returns structured_output on success", async () => {
    query.mockReturnValue(
      messages({ type: "result", subtype: "success", structured_output: { decision: "approve" } }),
    );

    const result = await runStructuredQuery("prompt", {}, { type: "object" });

    expect(result).toEqual({ ok: true, data: { decision: "approve" } });
  });

  it("fails closed when subtype is success but structured_output is missing", async () => {
    query.mockReturnValue(messages({ type: "result", subtype: "success" }));

    const result = await runStructuredQuery("prompt", {}, { type: "object" });

    expect(result.ok).toBe(false);
  });

  it("fails closed on error_max_structured_output_retries once retries are exhausted", async () => {
    // A fresh generator per call: query() is invoked more than once by the retry loop below,
    // and a spent async generator would otherwise make a second call look like "no result".
    query.mockImplementation(() => messages({ type: "result", subtype: "error_max_structured_output_retries" }));

    const result = await runStructuredQuery("prompt", {}, { type: "object" }, 0);

    expect(result.ok).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("retries error_max_structured_output_retries up to the given limit, then gives up", async () => {
    query.mockImplementation(() => messages({ type: "result", subtype: "error_max_structured_output_retries" }));

    const result = await runStructuredQuery("prompt", {}, { type: "object" }, 2);

    expect(result.ok).toBe(false);
    expect(query).toHaveBeenCalledTimes(3); // the original attempt plus 2 retries
  });

  it("recovers when a retry succeeds after the first attempt failed the same way", async () => {
    query
      .mockImplementationOnce(() => messages({ type: "result", subtype: "error_max_structured_output_retries" }))
      .mockImplementationOnce(() => messages({ type: "result", subtype: "success", structured_output: { ok: true } }));

    const result = await runStructuredQuery("prompt", {}, { type: "object" }, 2);

    expect(result).toEqual({ ok: true, data: { ok: true } });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("does not retry a different failure subtype, even with retries allowed", async () => {
    query.mockImplementation(() => messages({ type: "result", subtype: "error_max_turns" }));

    const result = await runStructuredQuery("prompt", {}, { type: "object" }, 2);

    expect(result.ok).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("does not retry is_error-flagged failures of a different kind (e.g. rate_limit)", async () => {
    query.mockImplementation(() =>
      messages({ type: "result", subtype: "success", is_error: true, result: "rate limited" }),
    );

    const result = await runStructuredQuery("prompt", {}, { type: "object" }, 2);

    expect(result.ok).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("sanitizes a thrown error instead of leaking its message", async () => {
    query.mockImplementation(() => {
      throw new Error("ENOENT: /etc/shadow-ish/secret");
    });

    const result = await runStructuredQuery("prompt", {}, { type: "object" });

    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("ENOENT");
  });

  it("fails closed when is_error is true, even if structured_output happens to be present", async () => {
    query.mockReturnValue(
      messages({
        type: "result",
        subtype: "success",
        is_error: true,
        structured_output: { verdict: "pass" },
      }),
    );

    const result = await runStructuredQuery("prompt", {}, { type: "object" });

    expect(result.ok).toBe(false);
    expect(result.data).toBeUndefined();
  });
});

describe("isolatedOptions", () => {
  it("does not load the operator's ~/.claude settings or MCP servers into a stage", async () => {
    query.mockReturnValue(messages({ type: "result", subtype: "success", result: "done" }));

    await runTextQuery("prompt", { allowedTools: ["Read"] });

    const [{ options }] = query.mock.calls[0];
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
  });

  it("limits tools to the declared set, plus gated writes and TaskStop where they apply", () => {
    const canUseTool = async () => ({ behavior: "allow" as const, updatedInput: {} });

    expect(isolatedOptions({ allowedTools: ["Read", "Glob", "Grep"] }).tools).toEqual(["Read", "Glob", "Grep"]);
    expect(isolatedOptions({ allowedTools: ["Read", "Bash(npm *)"], canUseTool }).tools).toEqual([
      "Read",
      "Bash",
      "Write",
      "Edit",
      "TaskStop",
    ]);
  });

  it("keeps a stage's own tools and settingSources", () => {
    const options = isolatedOptions({ allowedTools: ["Read"], tools: ["Read", "WebFetch"], settingSources: ["project"] });

    expect(options.tools).toEqual(["Read", "WebFetch"]);
    expect(options.settingSources).toEqual(["project"]);
  });
});

describe("step sessions", () => {
  it("starts a step's first query under the session id saved for it", async () => {
    const { StepJournal } = await import("./step-session.js");
    query.mockReturnValue(messages({ type: "result", subtype: "success", result: "done" }));
    const saved: unknown[] = [];

    await new StepJournal(undefined).run("design:review", async (active) => void saved.push(active), () =>
      runTextQuery("the prompt", {}),
    );

    const [{ prompt, options }] = query.mock.calls[0];
    expect(prompt).toBe("the prompt");
    expect(options.sessionId).toBe((saved[0] as { sessionId: string }).sessionId);
    expect(options.resume).toBeUndefined();
  });

  it("gives a second query in the same step a session of its own", async () => {
    const { StepJournal } = await import("./step-session.js");
    query.mockImplementation(() => messages({ type: "result", subtype: "success", result: "done" }));

    await new StepJournal(undefined).run("e2e", async () => {}, async () => {
      await runTextQuery("first", {});
      await runTextQuery("second", {});
    });

    expect(query.mock.calls[0][0].options.sessionId).toBeDefined();
    expect(query.mock.calls[1][0].options.sessionId).toBeUndefined();
  });

  it("leaves queries outside any step untouched", async () => {
    query.mockReturnValue(messages({ type: "result", subtype: "success", result: "done" }));

    await runTextQuery("plain", {});

    const [{ prompt, options }] = query.mock.calls[0];
    expect(prompt).toBe("plain");
    expect(options.sessionId).toBeUndefined();
    expect(options.resume).toBeUndefined();
  });

  it("builds a resume prompt that carries the fresh port block over", () => {
    const prompt = resumePrompt(
      ["--- Spec ---", "x", "", "--- Free ports for running the app ---", "These TCP ports: 50001.", "- rule"].join("\n"),
    );

    expect(prompt).toContain("Resumed after an interruption");
    expect(prompt).not.toContain("--- Spec ---");
    expect(prompt).toContain("These TCP ports: 50001.");
  });
});
