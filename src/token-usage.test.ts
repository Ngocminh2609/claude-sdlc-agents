import { beforeEach, describe, expect, it } from "vitest";
import {
  describeUsage,
  emptyUsage,
  onUsage,
  recordUsage,
  resetUsage,
  subtractUsage,
  totalTokens,
  usageOfResult,
  usageSoFar,
} from "./token-usage.js";
import { parseEventLine, encodeEvent } from "./events.js";

beforeEach(() => resetUsage());

describe("usageOfResult", () => {
  it("sums every model the call used, subagents included", () => {
    const usage = usageOfResult({
      modelUsage: {
        "claude-sonnet-5": { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 1000, cacheCreationInputTokens: 200, costUSD: 0.1 },
        "claude-haiku-4-5": { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 },
      },
      total_cost_usd: 0.11,
    });

    expect(usage).toMatchObject({ inputTokens: 110, outputTokens: 55, cacheReadTokens: 1000, cacheCreationTokens: 200 });
    expect(usage.costUsd).toBeCloseTo(0.11);
    expect(totalTokens(usage)).toBe(1365);
  });

  it("reads a result with no usage as zero rather than failing", () => {
    expect(usageOfResult({})).toEqual(emptyUsage());
  });
});

describe("running total", () => {
  it("adds each call and tells listeners the new total", () => {
    const seen: number[] = [];
    onUsage((total) => seen.push(total.outputTokens));

    recordUsage({ ...emptyUsage(), outputTokens: 5 });
    recordUsage({ ...emptyUsage(), outputTokens: 7 });

    expect(seen).toEqual([5, 12]);
    expect(usageSoFar().outputTokens).toBe(12);
  });

  it("skips an empty call so listeners are not woken for nothing", () => {
    let calls = 0;
    onUsage(() => calls++);
    recordUsage(emptyUsage());
    expect(calls).toBe(0);
  });

  it("gives the per-stage increase as the difference of two totals", () => {
    const before = { ...emptyUsage(), inputTokens: 10, costUsd: 0.5 };
    const after = { ...emptyUsage(), inputTokens: 25, costUsd: 0.75 };
    expect(subtractUsage(after, before)).toMatchObject({ inputTokens: 15, costUsd: 0.25 });
  });
});

describe("describeUsage", () => {
  it("reads in compact units with the split and cost", () => {
    expect(
      describeUsage({ inputTokens: 3400, outputTokens: 12000, cacheReadTokens: 1_100_000, cacheCreationTokens: 0, costUsd: 0.42 }),
    ).toBe("1.1M tokens (in 3.4k, out 12.0k, cache 1.1M) · ~$0.42");
  });
});

describe("usage event", () => {
  it("round-trips through the event stream", () => {
    const total = { ...emptyUsage(), inputTokens: 1, costUsd: 0.01 };
    expect(parseEventLine(encodeEvent({ type: "usage", total }))).toEqual({ type: "usage", total });
  });

  it("is dropped when its figures are malformed", () => {
    expect(parseEventLine(JSON.stringify({ type: "usage", total: { inputTokens: "1" } }))).toBeNull();
  });
});
