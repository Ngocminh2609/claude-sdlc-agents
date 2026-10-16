/**
 * Wire contract between the pipeline CLI (`src/index.ts`) and a front end that
 * runs it as a child process — today, the local web UI in `src/ui/`.
 *
 * Why a second output channel instead of reading the terminal output: the
 * CLI's human output (`[pipeline] Coding: task-1 (attempt 1/3)`) is written
 * for a person reading a terminal. A UI that scraped those strings would keep
 * "working" while silently tracking nothing the day someone reworded a
 * message. With `AIDEV_EVENT_STREAM=1` the CLI writes one JSON object per line
 * instead, so the front end parses a shape rather than prose.
 *
 * It is opt-in because plain text is the right default for a human at a
 * terminal — with the variable unset the CLI behaves exactly as before.
 *
 * The stream is deliberately line-based and mixed with ordinary output: any
 * line that is not a valid event is just log text (the Agent SDK and the
 * target project's own build tools write to the same stdout/stderr), so a
 * reader keeps both without needing a second pipe.
 */

import { isTokenUsage, type TokenUsage } from "./token-usage.js";
import type { StepNote, StepReport } from "./step-activity.js";

export const EVENT_STREAM_ENV = "AIDEV_EVENT_STREAM";

/** A stage boundary or per-attempt heartbeat from `runPipeline`'s onProgress. */
export interface PipelineProgressEvent {
  type: "progress";
  message: string;
}

/** Terminal event for a run that reached a pipeline verdict of its own. */
export interface PipelineFinishedEvent {
  type: "finished";
  status: string;
  message: string;
  logPath?: string;
}

/** Terminal event for a run that threw before producing a verdict. */
export interface PipelineCrashedEvent {
  type: "crashed";
  message: string;
}

/** The run's cumulative token usage, sent after every agent call finishes. */
export interface PipelineUsageEvent {
  type: "usage";
  total: TokenUsage;
}

/**
 * A step started, used a turn, ended, or a stage announced its steps — see
 * `step-activity.ts`. What the UI's mind map is drawn from.
 */
export type PipelineStepEvent = { type: "step" } & StepReport;

/** The run's spend cap, sent once at the start when one was set (`--max-run-usd`). */
export interface PipelineBudgetEvent {
  type: "budget";
  capUsd: number;
}

/**
 * `aidev sql-optimize`: every file done so far, each with every proposed step
 * and its outcome — sent after each file, so the UI can show each query's
 * before/after step by step while a folder is still being worked through.
 */
export interface PipelineSqlStepsEvent {
  type: "sql-steps";
  files: SqlFileView[];
}

/** One SQL file of a run, as the UI shows it. */
export interface SqlFileView {
  source: string;
  outputPath: string | null;
  dialect?: string;
  /** How the steps were measured on the test database, or why they were not. */
  verification?: string;
  /** The execution plan read for this file, and its format. */
  plan?: string;
  warnings?: string[];
  /** Why the file was not optimized at all. */
  error?: string;
  steps: SqlStepView[];
}

/** One optimization step as the UI shows it: its edits are applied together or not at all. */
export interface SqlStepView {
  index: number;
  status: "applied" | "rejected";
  statement: string;
  category: string;
  title: string;
  edits: { before: string; after: string }[];
  why: string;
  equivalence: string;
  /** Per edit, where it starts in the file as it was at that edit. */
  lines?: number[];
  rejectedBecause?: string;
  verdict?: string;
  verdictReason?: string;
  planEvidence?: string;
  /** Measured on the test database: same results or not, and the time before/after this step. */
  db?: { verdict: string; detail: string; msBefore: number; msAfter: number };
}

export type PipelineEvent =
  | PipelineSqlStepsEvent
  | PipelineProgressEvent
  | PipelineFinishedEvent
  | PipelineCrashedEvent
  | PipelineUsageEvent
  | PipelineStepEvent
  | PipelineBudgetEvent;

const STEP_NOTES: readonly StepNote[] = ["repeat", "blocked", "soft-cap"];

export function eventStreamEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[EVENT_STREAM_ENV] === "1";
}

export function encodeEvent(event: PipelineEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/**
 * Returns the event a line carries, or null when the line is ordinary log
 * output. Fail-closed on anything malformed: a half-written line or a log
 * message that happens to start with `{` must degrade to log text, never to a
 * half-populated event the UI would render as real state.
 */
export function parseEventLine(line: string): PipelineEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;

  switch (candidate.type) {
    case "progress":
      return typeof candidate.message === "string"
        ? { type: "progress", message: candidate.message }
        : null;
    case "finished":
      if (typeof candidate.status !== "string" || typeof candidate.message !== "string") return null;
      return {
        type: "finished",
        status: candidate.status,
        message: candidate.message,
        ...(typeof candidate.logPath === "string" ? { logPath: candidate.logPath } : {}),
      };
    case "usage":
      return isTokenUsage(candidate.total) ? { type: "usage", total: candidate.total } : null;
    case "crashed":
      return typeof candidate.message === "string"
        ? { type: "crashed", message: candidate.message }
        : null;
    case "step":
      return parseStepEvent(candidate);
    case "budget":
      return typeof candidate.capUsd === "number" && Number.isFinite(candidate.capUsd)
        ? { type: "budget", capUsd: candidate.capUsd }
        : null;
    case "sql-steps":
      return parseSqlStepsEvent(candidate);
    default:
      return null;
  }
}

function parseSqlStepsEvent(candidate: Record<string, unknown>): PipelineSqlStepsEvent | null {
  if (!Array.isArray(candidate.files)) return null;
  const files: SqlFileView[] = [];
  for (const raw of candidate.files as Record<string, unknown>[]) {
    if (typeof raw?.source !== "string") return null;
    const steps = parseSqlSteps(raw.steps);
    if (!steps) return null;
    const optional = (key: string) => (typeof raw[key] === "string" ? { [key]: raw[key] as string } : {});
    files.push({
      source: raw.source,
      outputPath: typeof raw.outputPath === "string" ? raw.outputPath : null,
      ...optional("dialect"),
      ...optional("verification"),
      ...optional("plan"),
      ...optional("error"),
      ...(Array.isArray(raw.warnings) ? { warnings: raw.warnings.filter((w): w is string => typeof w === "string") } : {}),
      steps,
    });
  }
  return { type: "sql-steps", files };
}

function parseSqlSteps(value: unknown): SqlStepView[] | null {
  if (!Array.isArray(value)) return null;
  const candidate = { steps: value } as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  const steps: SqlStepView[] = [];
  for (const raw of candidate.steps as Record<string, unknown>[]) {
    const fields = ["statement", "category", "title", "why", "equivalence"].map((key) => text(raw?.[key]));
    const edits = Array.isArray(raw?.edits)
      ? (raw.edits as Record<string, unknown>[]).filter((edit) => text(edit?.before) !== null && text(edit?.after) !== null)
      : null;
    if (
      typeof raw?.index !== "number" ||
      (raw.status !== "applied" && raw.status !== "rejected") ||
      fields.some((value) => value === null) ||
      !edits ||
      edits.length !== (raw.edits as unknown[]).length
    ) {
      return null;
    }
    const [statement, category, title, why, equivalence] = fields as string[];
    const lines = Array.isArray(raw.lines) && raw.lines.every((line) => typeof line === "number") ? (raw.lines as number[]) : null;
    steps.push({
      index: raw.index,
      status: raw.status,
      statement,
      category,
      title,
      edits: edits.map((edit) => ({ before: edit.before as string, after: edit.after as string })),
      why,
      equivalence,
      ...(lines ? { lines } : {}),
      ...(text(raw.rejectedBecause) ? { rejectedBecause: raw.rejectedBecause as string } : {}),
      ...(text(raw.verdict) ? { verdict: raw.verdict as string } : {}),
      ...(text(raw.verdictReason) ? { verdictReason: raw.verdictReason as string } : {}),
      ...(text(raw.planEvidence) ? { planEvidence: raw.planEvidence as string } : {}),
      ...(isDbCheck(raw.db) ? { db: raw.db } : {}),
    });
  }
  return steps;
}

function isDbCheck(value: unknown): value is NonNullable<SqlStepView["db"]> {
  const db = value as Record<string, unknown> | undefined;
  return typeof db?.verdict === "string" && typeof db.detail === "string" && typeof db.msBefore === "number" && typeof db.msAfter === "number";
}

function parseStepEvent(candidate: Record<string, unknown>): PipelineStepEvent | null {
  if (candidate.phase === "plan") {
    if (candidate.group !== "coding" && candidate.group !== "port") return null;
    if (!Array.isArray(candidate.items)) return null;
    const items = candidate.items.filter(
      (item): item is { id: string; label: string } =>
        typeof item?.id === "string" && typeof item?.label === "string",
    );
    if (items.length !== candidate.items.length) return null;
    return { type: "step", phase: "plan", group: candidate.group, items: items.map(({ id, label }) => ({ id, label })) };
  }
  if (typeof candidate.step !== "string") return null;
  if (candidate.phase !== "start" && candidate.phase !== "turn" && candidate.phase !== "end") return null;
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
  const turns = count(candidate.turns);
  const maxTurns = count(candidate.maxTurns);
  const note = STEP_NOTES.find((kind) => kind === candidate.note);
  return {
    type: "step",
    step: candidate.step,
    phase: candidate.phase,
    ...(turns !== undefined ? { turns } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(typeof candidate.ok === "boolean" ? { ok: candidate.ok } : {}),
    ...(note ? { note } : {}),
  };
}
