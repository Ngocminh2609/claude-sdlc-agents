/**
 * Token accounting for a pipeline run.
 *
 * Every agent call ends in one SDK `result` message whose `modelUsage` covers
 * that whole `query()` call — main loop, subagents, compaction — per model.
 * Each stage call is its own `query()`, so summing those results across calls
 * is the run's total. `sdk-helpers.ts` records each one here; the CLI turns the
 * running total into events, and the UI attributes each increase to the stage
 * that was active when it arrived.
 *
 * Figures are the SDK's own estimate, not a billing statement.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

export function subtractUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens - b.inputTokens,
    outputTokens: a.outputTokens - b.outputTokens,
    cacheReadTokens: a.cacheReadTokens - b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens - b.cacheCreationTokens,
    costUsd: a.costUsd - b.costUsd,
  };
}

/** Every token the run moved, cached or not. */
export function totalTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
}

interface ModelUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
}

/** The usage one SDK result message reports, summed over the models it used. */
export function usageOfResult(message: {
  modelUsage?: Record<string, ModelUsageLike>;
  total_cost_usd?: number;
}): TokenUsage {
  let usage = emptyUsage();
  for (const model of Object.values(message.modelUsage ?? {})) {
    usage = addUsage(usage, {
      inputTokens: model.inputTokens ?? 0,
      outputTokens: model.outputTokens ?? 0,
      cacheReadTokens: model.cacheReadInputTokens ?? 0,
      cacheCreationTokens: model.cacheCreationInputTokens ?? 0,
      costUsd: model.costUSD ?? 0,
    });
  }
  // Per-model cost can be absent where the total is not; prefer the larger.
  if ((message.total_cost_usd ?? 0) > usage.costUsd) usage.costUsd = message.total_cost_usd ?? 0;
  return usage;
}

export function isTokenUsage(value: unknown): value is TokenUsage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "costUsd"].every(
    (key) => typeof v[key] === "number" && Number.isFinite(v[key]),
  );
}

/** "1.2M tokens (in 3.4k, out 12k, cache 1.1M) · ~$0.42" */
export function describeUsage(usage: TokenUsage): string {
  const cache = usage.cacheReadTokens + usage.cacheCreationTokens;
  return (
    `${compact(totalTokens(usage))} tokens (in ${compact(usage.inputTokens)}, out ${compact(usage.outputTokens)}, ` +
    `cache ${compact(cache)}) · ~$${usage.costUsd.toFixed(2)}`
  );
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// --- Process-wide running total -------------------------------------------

let runTotal = emptyUsage();
const listeners = new Set<(total: TokenUsage) => void>();

export function recordUsage(usage: TokenUsage): void {
  if (totalTokens(usage) === 0 && usage.costUsd === 0) return;
  runTotal = addUsage(runTotal, usage);
  for (const listener of listeners) listener({ ...runTotal });
}

export function usageSoFar(): TokenUsage {
  return { ...runTotal };
}

/** Returns an unsubscribe function. */
export function onUsage(listener: (total: TokenUsage) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tests only. */
export function resetUsage(): void {
  runTotal = emptyUsage();
  listeners.clear();
}
