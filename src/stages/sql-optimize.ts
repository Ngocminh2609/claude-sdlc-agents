import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { runStructuredQuery } from "../sdk-helpers.js";
import { config, limitsOf } from "../config.js";
import { StageError } from "../stage-error.js";
import {
  OPTIMIZE_DIALECTS,
  STEP_CATEGORIES,
  type OptimizeDialect,
  type ProposedStep,
  type StepVerdict,
} from "../sql-file.js";

/**
 * SQL optimization in two agent calls, neither with tools (the file is in the
 * prompt; nothing is read, nothing is run):
 *
 * 1. Propose — a list of edits, each "replace this exact code with that", with
 *    the query it touches, why it is faster and why the results stay the same.
 *    The model never rewrites the whole file: plain code applies the edits
 *    (`applySteps`), so code no edit names cannot change.
 * 2. Check — a separate session judges each edit, looking only at whether the
 *    results and side effects stay the same. An edit it does not confirm is not
 *    applied (fail-closed). A logic change passes only when the person asked
 *    for it in the instructions.
 */

const PERFORMANCE_ONLY = `THE HARD RULE: optimize for performance and database load ONLY. The business
logic must stay exactly as it is: every input gives the same rows, the same
columns in the same order, the same values (rounding, NULLs, duplicates,
collation), the same output parameters and return codes, the same writes, the
same errors and the same transaction and locking behaviour. Never add, drop or
loosen a filter, change a join's type, change defaults, or "fix" what looks like
a bug — report a suspected bug as a warning instead.`;

const PROPOSE_PROMPT = `You are a senior database performance engineer. You receive one SQL file
(stored procedures, functions, views or queries) and propose edits that reduce
database load and execution time.

${PERFORMANCE_ONLY}

The only exception: changes the person explicitly asks for under "Requested
changes" (if that section is present). Such an edit uses category
"requested-logic" and must do exactly what was asked, nothing more.

A rewrite you are not certain is equivalent is NOT proposed as an edit: put it in
"warnings" as a suggestion, with what would have to be true for it to be safe.

Practice to apply (vendor docs, Use The Index Luke, Brent Ozar, Percona, the
PostgreSQL wiki), each only when exactly equivalent:
- Sargable predicates: no functions or arithmetic on an indexed column in
  WHERE/JOIN; avoid implicit conversions (compare like types).
- Filter early: push conditions into the subquery/CTE/join that produces rows.
- EXISTS instead of COUNT(*) > 0 or IN over a large subquery when only existence
  matters. NOT IN → NOT EXISTS only when the column cannot be NULL.
- Explicit column list instead of SELECT * ONLY when the columns are defined in
  this file (CREATE TABLE, temp table, table variable); otherwise a warning.
- Remove work that cannot change the result: ORDER BY in a subquery/CTE without
  TOP/LIMIT, DISTINCT over a unique key, a second read of the same table that
  one pass can replace.
- Cursors and row-by-row loops → one set-based statement when the logic maps
  exactly.
- Correlated subqueries that run once per outer row (a plan shows them with many
  loops) → one pre-aggregated derived table or CTE joined once (LEFT JOIN, grouped
  by the correlation key). Mind the empty case: count of no rows is 0, so wrap it
  in COALESCE(…, 0); sum/min/max/avg of no rows is NULL, so leave those bare.
  Keep the outer row set exactly as it was (no duplicates from the join).
- UNION → UNION ALL only when duplicates are impossible by construction.
- SQL Server: SET NOCOUNT ON at the start of a procedure. Do not add NOLOCK
  (changes results) and do not add a schema prefix the file does not already use
  for that object.
- MySQL/PostgreSQL: keyset pagination, STABLE/IMMUTABLE markings and similar
  only as warnings unless provably equivalent.
- Never add CREATE INDEX to the code: put index DDL in "indexSuggestions", one
  statement each, with a short comment line above it naming the query it helps.

When a "Schema" section is given (read from the real database catalog or a file
the person supplied), use it: SELECT * may become the table's real column list in
the table's column order; NOT IN → NOT EXISTS is allowed when the column is NOT
NULL there; never suggest an index that already exists (or is a prefix of one);
compare against the real column types for implicit conversions. Without it, do
none of these — warn instead.

When an "Execution plan" section is given, it is where the time really goes:
work on its hotspots first — the most expensive operators, full scans, estimates
far off from actual rows, implicit conversions, spills, missing indexes. For each
step, "planEvidence" names the plan line it addresses (e.g. "Seq Scan on orders,
62% of time"); leave it empty when the step does not come from the plan. Missing
indexes the plan reports go to "indexSuggestions" (never into the code), unless
the schema shows an equivalent index already exists. A plan explains cost; it
never justifies changing results.

Each step is ONE optimization, reviewed and applied all-or-nothing:
- "edits": the code changes it needs, applied in order. Each "before" is code
  copied VERBATIM from the file, long enough to occur only once, as the file is
  after the earlier steps and edits; "after" is its replacement. Keep the
  original comments and formatting style.
- Edits that only make sense together belong to the SAME step — e.g. replacing a
  cursor loop = moving the work into the INSERT + removing the loop + removing
  its variable. Never split them: a half-applied rewrite can be slower than the
  original. Independent optimizations are separate steps.
- "statement": the query it touches, e.g. "dbo.usp_GetOrders — INSERT INTO @Result".
- "why": how it lowers load or time. "equivalence": why every input still gives
  the same results and side effects.
No steps at all is a valid answer when the code is already fine.`;

const CHECK_PROMPT = `You are a strict reviewer of SQL performance changes. Each numbered step is one
optimization made of one or more edits that are applied together. For each step,
decide one thing: with ALL its edits applied, do the results and side effects stay
EXACTLY the same for every possible input and data — rows, columns and their
order, values, NULL handling, duplicates, output parameters, writes, errors,
transactions and locking?

- "same-results": you are certain they do.
- "changes-results": some input or data gives a different outcome — name it.
- "unsure": you cannot show it either way from this file alone (it depends on
  the schema, constraints or data you cannot see).
- "requested-change": the edit changes results, and it does exactly what the
  person asked under "Requested changes" — nothing more. Only possible when that
  section is present.

Judge each step applied to the code as it stands after the earlier steps. Do not
judge whether it is faster. Under concurrent writes, reading the same data once
instead of in several statements is not a result change when every outcome the
new code can produce is one the original could also produce at the same
isolation level. When a "Schema" section is given, it is the real table
definitions and existing indexes: use it to judge NULL-ability, column lists and
types. Be skeptical: when in doubt, "unsure".`;

const PROPOSE_SCHEMA = {
  type: "object",
  properties: {
    dialect: { type: "string", enum: OPTIMIZE_DIALECTS },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          statement: { type: "string" },
          category: { type: "string", enum: STEP_CATEGORIES },
          title: { type: "string" },
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: { before: { type: "string" }, after: { type: "string" } },
              required: ["before", "after"],
            },
          },
          why: { type: "string" },
          equivalence: { type: "string" },
          planEvidence: { type: "string" },
        },
        required: ["statement", "category", "title", "edits", "why", "equivalence"],
      },
    },
    warnings: { type: "array", items: { type: "string" } },
    indexSuggestions: { type: "array", items: { type: "string" } },
  },
  required: ["dialect", "steps", "warnings", "indexSuggestions"],
};

const CHECK_SCHEMA = {
  type: "object",
  properties: {
    checks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          step: { type: "integer" },
          verdict: { type: "string", enum: ["same-results", "changes-results", "unsure", "requested-change"] },
          reason: { type: "string" },
        },
        required: ["step", "verdict", "reason"],
      },
    },
  },
  required: ["checks"],
};

export interface SqlOptimizeInput {
  sql: string;
  fileName: string;
  /** Chosen by the person, or detected from the text; null leaves it to the model. */
  dialect: OptimizeDialect | null;
  /** True when the person chose it, false when it was only detected. */
  dialectChosen: boolean;
  /** Logic changes the person explicitly asks for. Empty: performance only. */
  instructions?: string;
  /** Real table definitions and indexes (test database catalog, or a file the person gave). */
  schema?: string;
  /** The execution plan's hotspots, summarized by plain code (`sql-plan.ts`). */
  plan?: string;
}

export interface SqlProposal {
  dialect: OptimizeDialect;
  steps: ProposedStep[];
  warnings: string[];
  indexSuggestions: string[];
}

function optionsFor(systemPrompt: string, stage: "sqlOptimize" | "sqlCheck"): Options {
  // The file is in the prompt; there is nothing to read and nothing to run.
  const model = stage === "sqlCheck" ? config.sqlCheckModel : config.model;
  return { systemPrompt, allowedTools: [], model, ...limitsOf(stage) };
}

function planSection(plan: string | undefined): string[] {
  return plan?.trim() ? ["", "--- Execution plan (hotspots, read from the person's plan file) ---", plan.trim()] : [];
}

function schemaSection(schema: string | undefined): string[] {
  return schema?.trim() ? ["", "--- Schema (real tables, columns and existing indexes) ---", schema.trim()] : [];
}

function requestedSection(instructions: string | undefined): string[] {
  return instructions?.trim() ? ["", "--- Requested changes (asked for explicitly by the person) ---", instructions.trim()] : [];
}

export async function proposeSqlSteps(input: SqlOptimizeInput): Promise<SqlProposal> {
  const dialectLine = input.dialect
    ? input.dialectChosen
      ? `Dialect: ${input.dialect} (chosen by the person — write for it).`
      : `Dialect: probably ${input.dialect} (detected from the syntax — confirm it from the code).`
    : `Dialect: not detected — decide from the code (one of ${OPTIMIZE_DIALECTS.join(", ")}).`;
  const prompt = [
    `File: ${input.fileName}`,
    dialectLine,
    ...requestedSection(input.instructions),
    ...planSection(input.plan),
    ...schemaSection(input.schema),
    "",
    "--- SQL ---",
    input.sql,
  ].join("\n");

  const result = await runStructuredQuery<SqlProposal>(prompt, optionsFor(PROPOSE_PROMPT, "sqlOptimize"), PROPOSE_SCHEMA);
  if (!result.ok || !result.data) throw new StageError(`sql-optimize stage failed: ${result.error ?? "empty answer"}`);
  const data = result.data;
  return {
    dialect: input.dialectChosen && input.dialect ? input.dialect : data.dialect,
    steps: data.steps ?? [],
    warnings: data.warnings ?? [],
    indexSuggestions: data.indexSuggestions ?? [],
  };
}

/** The checker's verdict per step number (1-based); a step it skipped has none. */
export async function checkSqlSteps(
  input: Pick<SqlOptimizeInput, "sql" | "instructions" | "schema">,
  steps: ProposedStep[],
): Promise<Map<number, { verdict: StepVerdict; reason: string }>> {
  const prompt = [
    ...requestedSection(input.instructions),
    ...schemaSection(input.schema),
    "",
    "--- Original SQL ---",
    input.sql,
    "",
    "--- Steps, applied in this order ---",
    ...steps.flatMap((step, index) => [
      "",
      `Step ${index + 1} — ${step.statement}`,
      ...step.edits.flatMap((edit, position) => [
        `Edit ${position + 1}/${step.edits.length} before:`,
        edit.before,
        "After:",
        edit.after,
      ]),
    ]),
  ].join("\n");

  const result = await runStructuredQuery<{ checks: { step: number; verdict: StepVerdict; reason: string }[] }>(
    prompt,
    optionsFor(CHECK_PROMPT, "sqlCheck"),
    CHECK_SCHEMA,
  );
  if (!result.ok || !result.data) throw new StageError(`sql-check stage failed: ${result.error ?? "empty answer"}`);
  return new Map(result.data.checks.map((check) => [check.step, { verdict: check.verdict, reason: check.reason }]));
}

/**
 * Why a checked step may not be applied, or null when it may. Fail-closed:
 * no verdict is a rejection, and a logic change needs both the person's
 * request and the checker's agreement that it is what was asked.
 */
export function rejectionOf(
  step: ProposedStep,
  check: { verdict: StepVerdict; reason: string } | undefined,
  instructions: string | undefined,
): string | null {
  if (!check) return "the independent check gave no verdict";
  const requested = Boolean(instructions?.trim());
  if (step.category === "requested-logic") {
    if (!requested) return "it changes business logic, and no change was requested";
    return check.verdict === "requested-change" || check.verdict === "same-results"
      ? null
      : `the check found it is not what was requested (${check.verdict}): ${check.reason}`;
  }
  if (check.verdict === "same-results") return null;
  if (check.verdict === "requested-change") return "it changes business logic but was filed as a performance edit";
  return `the check could not confirm the results stay the same (${check.verdict}): ${check.reason}`;
}
