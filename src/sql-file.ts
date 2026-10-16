import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SqlDialect } from "./database.js";

/**
 * Plain-code side of `aidev sql-optimize`: reading a SQL file the way it was
 * saved, guessing its dialect, and writing the optimized copy next to it in
 * the same encoding and line endings — so a diff against the original shows
 * only what the optimization changed.
 */

/** The dialects the optimizer handles. */
export type OptimizeDialect = Extract<SqlDialect, "sqlserver" | "mysql" | "postgresql">;
export const OPTIMIZE_DIALECTS: OptimizeDialect[] = ["sqlserver", "mysql", "postgresql"];

/** Larger files would not fit the model's answer in one piece. */
export const MAX_SQL_CHARS = 100_000;

export interface SqlFile {
  text: string;
  /** How it was stored: SQL Server Management Studio saves UTF-16 LE by default. */
  encoding: "utf8" | "utf8-bom" | "utf16le";
  eol: "\r\n" | "\n";
}

export async function readSqlFile(file: string): Promise<SqlFile> {
  const bytes = await readFile(file);
  let encoding: SqlFile["encoding"] = "utf8";
  let text: string;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf16le";
    text = bytes.subarray(2).toString("utf16le");
  } else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    encoding = "utf8-bom";
    text = bytes.subarray(3).toString("utf8");
  } else {
    text = bytes.toString("utf8");
  }
  return { text, encoding, eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

export async function writeSqlFile(file: string, text: string, like: Pick<SqlFile, "encoding" | "eol">): Promise<void> {
  const body = text.replace(/\r?\n/g, like.eol);
  const bytes =
    like.encoding === "utf16le"
      ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, "utf16le")])
      : like.encoding === "utf8-bom"
        ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, "utf8")])
        : Buffer.from(body, "utf8");
  await writeFile(file, bytes);
}

/** `proc.sql` → `proc_optimized.sql`, next to the original. */
export function optimizedPathOf(file: string): string {
  const parsed = path.parse(path.resolve(file));
  return path.join(parsed.dir, `${parsed.name}_optimized${parsed.ext || ".sql"}`);
}

/**
 * The dialect the text is written in, from syntax only one dialect uses, or
 * null when nothing decides it. A hint for the model, which confirms it.
 */
export function detectDialect(sql: string): OptimizeDialect | null {
  const text = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const score: Record<OptimizeDialect, number> = { sqlserver: 0, mysql: 0, postgresql: 0 };
  const hit = (dialect: OptimizeDialect, pattern: RegExp) => {
    if (pattern.test(text)) score[dialect]++;
  };
  hit("sqlserver", /^\s*GO\s*$/im);
  hit("sqlserver", /\bSET\s+NOCOUNT\b/i);
  hit("sqlserver", /\bWITH\s*\(\s*NOLOCK\s*\)/i);
  hit("sqlserver", /\bSELECT\s+TOP\b/i);
  hit("sqlserver", /\[[A-Za-z_][\w ]*\]\.\[/);
  hit("sqlserver", /\b(NVARCHAR|DATETIME2|UNIQUEIDENTIFIER|IDENTITY\s*\()/i);
  hit("sqlserver", /\bCREATE\s+(OR\s+ALTER\s+)?PROC(EDURE)?\b[\s\S]*?\bAS\b\s*(BEGIN|SET|SELECT|DECLARE)/i);
  hit("mysql", /^\s*DELIMITER\b/im);
  hit("mysql", /`[A-Za-z_]\w*`/);
  hit("mysql", /\b(AUTO_INCREMENT|ENGINE\s*=|UNSIGNED)\b/i);
  hit("mysql", /\bLIMIT\s+\d+\s*,\s*\d+/i);
  hit("mysql", /\bDECLARE\s+\w+\s+CURSOR\s+FOR\b[\s\S]*\bDECLARE\s+CONTINUE\s+HANDLER\b/i);
  hit("postgresql", /\$\$|\$[A-Za-z_]\w*\$/);
  hit("postgresql", /\bLANGUAGE\s+'?plpgsql'?/i);
  hit("postgresql", /::\s*[A-Za-z_]\w*/);
  hit("postgresql", /\bRETURNS\s+(SETOF|TABLE|TRIGGER)\b/i);
  hit("postgresql", /\b(ILIKE|SERIAL|BIGSERIAL|JSONB)\b/i);
  hit("postgresql", /\bRAISE\s+(NOTICE|EXCEPTION)\b/i);
  const ranked = OPTIMIZE_DIALECTS.map((dialect) => [dialect, score[dialect]] as const).sort((a, b) => b[1] - a[1]);
  return ranked[0][1] > 0 && ranked[0][1] > ranked[1][1] ? ranked[0][0] : null;
}

/** What a step does. Every kind but the last is performance only. */
export const STEP_CATEGORIES = [
  "sargable-filter",
  "set-based",
  "existence-check",
  "column-list",
  "redundant-work",
  "join-rewrite",
  "session-setting",
  "other-performance",
  // A change to what the code returns or writes — only when the person asked for it.
  "requested-logic",
] as const;
export type StepCategory = (typeof STEP_CATEGORIES)[number];

/** Replace exactly `before` (verbatim code) with `after`. */
export interface SqlEdit {
  before: string;
  after: string;
}

/**
 * One optimization the model proposes. Its edits only make sense together
 * (a cursor rewrite removes the loop, its variable and moves the work into
 * the INSERT), so they are checked and applied as one: all or none. A half-
 * applied rewrite can be slower than the original.
 */
export interface ProposedStep {
  /** The query it touches: procedure/function plus the statement, in words. */
  statement: string;
  category: StepCategory;
  title: string;
  /** Applied in order, each to the text the previous one left. */
  edits: SqlEdit[];
  /** Why it lowers load or time. */
  why: string;
  /** Why the results and side effects stay the same. */
  equivalence: string;
}

/** The independent check's verdict on one step. */
export type StepVerdict = "same-results" | "changes-results" | "unsure" | "requested-change";

export interface StepOutcome extends ProposedStep {
  /** 1-based, in the order the model proposed and the code applied them. */
  index: number;
  status: "applied" | "rejected";
  /** Per edit, the line where it starts, in the file as it was at that edit. */
  lines?: number[];
  rejectedBecause?: string;
  check?: { verdict: StepVerdict; reason: string };
}

export interface OptimizationReport {
  dialect: OptimizeDialect;
  steps: StepOutcome[];
  /** What a person must check: assumptions, schema-dependent points, suggestions not applied. */
  warnings: string[];
  /** Index DDL worth considering — written as comments, never run. */
  indexSuggestions: string[];
}

/**
 * Applies accepted steps to the original, in order, each to the text the
 * previous one left. An edit lands only where its `before` occurs exactly
 * once (whitespace may differ — the model re-types code); one edit of a step
 * that cannot land rejects the whole step, never guessed into place. Text no
 * applied edit touches stays byte-for-byte as it was.
 */
export function applySteps(
  original: string,
  steps: (ProposedStep & { index: number; check?: StepOutcome["check"] })[],
  rejectedUpFront: Map<number, string>,
): { text: string; outcomes: StepOutcome[] } {
  let text = original;
  const outcomes: StepOutcome[] = [];
  for (const step of steps) {
    const upFront = rejectedUpFront.get(step.index);
    if (upFront) {
      outcomes.push({ ...step, status: "rejected", rejectedBecause: upFront });
      continue;
    }
    const attempt = applyEdits(text, step.edits);
    if ("failure" in attempt) {
      outcomes.push({ ...step, status: "rejected", rejectedBecause: attempt.failure });
      continue;
    }
    text = attempt.text;
    outcomes.push({ ...step, status: "applied", lines: attempt.lines });
  }
  return { text, outcomes };
}

/** All of a step's edits on a copy of the text, or why one of them cannot land. */
function applyEdits(text: string, edits: SqlEdit[]): { text: string; lines: number[] } | { failure: string } {
  if (!edits.length) return { failure: "the step has no edit" };
  const lines: number[] = [];
  for (const [position, edit] of edits.entries()) {
    const which = edits.length > 1 ? `edit ${position + 1} of ${edits.length}: ` : "";
    const tokens = edit.before.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length || edit.before.trim() === edit.after.trim()) return { failure: `${which}empty or no-op edit` };
    const pattern = new RegExp(tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "g");
    const matches = [...text.matchAll(pattern)];
    if (matches.length !== 1) {
      return {
        failure: matches.length
          ? `${which}the code to replace occurs ${matches.length} times — not applied rather than guessed`
          : `${which}the code to replace was not found in the file`,
      };
    }
    const [match] = matches;
    const at = match.index ?? 0;
    lines.push(text.slice(0, at).split("\n").length);
    text = text.slice(0, at) + edit.after.trim() + text.slice(at + match[0].length);
  }
  return { text, lines };
}

const DIALECT_LABEL: Record<OptimizeDialect, string> = { sqlserver: "SQL Server", mysql: "MySQL", postgresql: "PostgreSQL" };

/**
 * The optimized file: a comment header with every step — the query it
 * touches, the code before and after, why it is faster and why the results
 * stay the same — then the SQL.
 */
export function renderOptimizedFile(report: OptimizationReport, sql: string, sourceFile: string, now = new Date()): string {
  const comment = (text: string, indent = "--   ") => text.split(/\r?\n/).map((line) => `${indent}${line}`.trimEnd());
  const applied = report.steps.filter((step) => step.status === "applied");
  const rejected = report.steps.filter((step) => step.status === "rejected");
  const lines = [
    `-- Optimized by aidev on ${now.toISOString().slice(0, 10)} from ${path.basename(sourceFile)} (${DIALECT_LABEL[report.dialect]}).`,
    "-- Only the steps below were changed; every other line is the original, unchanged.",
    "-- Review before deploying: compare with the original and test on real data.",
  ];
  if (!applied.length) lines.push("--", "-- No step applied — the file below is the original.");
  for (const step of applied) {
    lines.push(
      "--",
      `-- Step ${step.index}: ${step.title}${step.category === "requested-logic" ? "  [LOGIC CHANGE — requested]" : ""}`,
      `--   Query: ${step.statement}`,
      ...comment(`Faster because: ${step.why}`),
      ...comment(`Same results because: ${step.equivalence}`),
      ...(step.check ? comment(`Independent check: ${step.check.verdict} — ${step.check.reason}`) : []),
    );
    step.edits.forEach((edit, position) => {
      const which = step.edits.length > 1 ? ` ${position + 1}/${step.edits.length}` : "";
      lines.push(
        `--   Before${which} (line ${step.lines?.[position] ?? "?"}):`,
        ...comment(edit.before.trim(), "--     "),
        "--   After:",
        ...comment(edit.after.trim(), "--     "),
      );
    });
  }
  if (rejected.length) {
    lines.push("--", "-- Proposed but NOT applied:");
    for (const step of rejected) lines.push(...comment(`- Step ${step.index}: ${step.title} — ${step.rejectedBecause}`));
  }
  if (report.warnings.length) {
    lines.push("--", "-- Check before use:", ...report.warnings.flatMap((warning) => comment(`- ${warning}`)));
  }
  if (report.indexSuggestions.length) {
    lines.push("--", "-- Index suggestions (not applied — check the existing indexes first):", ...report.indexSuggestions.flatMap((ddl) => comment(ddl)));
  }
  return `${lines.join("\n")}\n\n${sql.trim()}\n`;
}
