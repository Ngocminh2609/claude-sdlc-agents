import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query }));

const { runTextQuery, runStructuredQuery } = await import("./sdk-helpers.js");

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
