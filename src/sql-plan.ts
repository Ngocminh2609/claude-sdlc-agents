import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { readSqlFile, type OptimizeDialect } from "./sql-file.js";

/**
 * Reads an execution plan the person saved, by plain code, into the few lines
 * an optimizer needs: where the cost goes, which tables are scanned in full,
 * where the estimates are far off, what the engine itself warns about, and the
 * indexes it says are missing. A raw plan is not sent to the model: a SQL
 * Server `.sqlplan` runs to megabytes of XML for one procedure.
 *
 * Formats: SQL Server showplan XML (`.sqlplan`, or `SET STATISTICS XML`),
 * PostgreSQL `EXPLAIN (FORMAT JSON)` (with or without ANALYZE), MySQL
 * `EXPLAIN FORMAT=JSON`, and any text plan (PostgreSQL/MySQL text EXPLAIN,
 * SQL Server SHOWPLAN_TEXT), passed on trimmed.
 */

export interface PlanSummary {
  format: "sqlserver-xml" | "postgresql-json" | "mysql-json" | "text";
  /** The engine the plan comes from, when the format says so. */
  dialect?: OptimizeDialect;
  /** Prompt-ready lines, most expensive first. */
  text: string;
  /** How many operators/nodes the plan held, for the progress line. */
  operators: number;
}

const MAX_HOTSPOTS = 25;
const MAX_TEXT_CHARS = 12_000;

export async function readPlanFile(file: string): Promise<PlanSummary> {
  // SSMS saves .sqlplan as UTF-16; readSqlFile reads whichever encoding the BOM says.
  return summarizePlan((await readSqlFile(file)).text);
}

export function summarizePlan(raw: string): PlanSummary {
  const text = raw.replace(/^﻿/, "").trim();
  if (/<ShowPlanXML\b/i.test(text)) return sqlServerXml(text);
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text);
      const root = Array.isArray(parsed) ? parsed[0] : parsed;
      if (root && typeof root === "object" && "Plan" in root) return postgresJson(root as Record<string, unknown>);
      if (root && typeof root === "object" && "query_block" in root) return mysqlJson(root as Record<string, unknown>);
    } catch {
      // Not JSON after all: treat it as a text plan.
    }
  }
  return plainText(text);
}

/** The plan for a SQL file: the given plan file, or in a plan folder the file with the same base name. */
export function planFileFor(planPath: string | undefined, sqlFile: string): string | null {
  if (!planPath) return null;
  const resolved = path.resolve(planPath);
  if (!existsSync(resolved)) throw new Error(`Execution plan not found: ${resolved}`);
  if (statSync(resolved).isFile()) return resolved;
  const base = path.basename(sqlFile).replace(/\.sql$/i, "").toLowerCase();
  const match = readdirSync(resolved).find((name) => {
    const lower = name.toLowerCase();
    return lower.startsWith(`${base}.`) && !lower.endsWith(".sql") && statSync(path.join(resolved, name)).isFile();
  });
  return match ? path.join(resolved, match) : null;
}

// --- SQL Server showplan XML ------------------------------------------------

const attr = (tag: string, name: string): string | undefined => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
const num = (value: string | undefined) => (value === undefined ? undefined : Number(value));
const xmlText = (value: string) =>
  value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#x(\w+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/&amp;/g, "&");

function sqlServerXml(xml: string): PlanSummary {
  const lines: string[] = [];
  const statements = [...xml.matchAll(/<StmtSimple\b[^>]*>/g)].map((match) => match[0]);
  const stmtCost = statements.reduce((sum, tag) => sum + (num(attr(tag, "StatementSubTreeCost")) ?? 0), 0);
  for (const [i, tag] of statements.entries()) {
    const sql = xmlText(attr(tag, "StatementText") ?? "").replace(/\s+/g, " ").trim();
    const cost = num(attr(tag, "StatementSubTreeCost")) ?? 0;
    if (sql) lines.push(`Statement ${i + 1} (cost ${round(cost)}${stmtCost ? `, ${pct(cost, stmtCost)} of all` : ""}): ${sql.slice(0, 300)}`);
  }

  // Each RelOp up to the next one: its own attributes, its first object, its runtime rows.
  const chunks = xml.split(/(?=<RelOp\b)/).filter((chunk) => chunk.startsWith("<RelOp"));
  const ops = chunks.map((chunk) => {
    const tag = /^<RelOp\b[^>]*>/.exec(chunk)?.[0] ?? "";
    const object = /<Object\b[^>]*\/?>/.exec(chunk)?.[0];
    const actual = [...chunk.matchAll(/<RunTimeCountersPerThread\b[^>]*\bActualRows="(\d+)"/g)].reduce((sum, m) => sum + Number(m[1]), 0);
    const hasActual = /<RunTimeCountersPerThread\b/.test(chunk);
    return {
      physical: attr(tag, "PhysicalOp") ?? "?",
      logical: attr(tag, "LogicalOp") ?? "",
      subtree: num(attr(tag, "EstimatedTotalSubtreeCost")) ?? 0,
      own: (num(attr(tag, "EstimateIO")) ?? 0) + (num(attr(tag, "EstimateCPU")) ?? 0),
      estRows: num(attr(tag, "EstimateRows")) ?? 0,
      actualRows: hasActual ? actual : undefined,
      object: object
        ? [attr(object, "Schema"), attr(object, "Table"), attr(object, "Index")].filter(Boolean).map((part) => part?.replace(/[[\]]/g, "")).join(".")
        : "",
    };
  });
  const total = stmtCost || Math.max(1, ...ops.map((op) => op.subtree));
  const hot = [...ops].sort((a, b) => b.own - a.own).slice(0, MAX_HOTSPOTS);
  if (hot.length) lines.push("", "Most expensive operators (own estimated cost):");
  for (const op of hot) {
    const scan = /Scan/.test(op.physical) && !/Seek/.test(op.physical) ? " [FULL SCAN]" : "";
    const misestimate =
      op.actualRows !== undefined && op.estRows > 0 && (op.actualRows / op.estRows > 10 || op.estRows / Math.max(op.actualRows, 1) > 10)
        ? ` [ESTIMATE OFF: est ${round(op.estRows)} vs actual ${op.actualRows}]`
        : "";
    lines.push(
      `- ${op.physical}${op.logical && op.logical !== op.physical ? ` (${op.logical})` : ""}${op.object ? ` on ${op.object}` : ""}: ${pct(op.own, total)} of cost, est rows ${round(op.estRows)}${
        op.actualRows !== undefined ? `, actual ${op.actualRows}` : ""
      }${scan}${misestimate}`,
    );
  }

  const warnings: string[] = [];
  for (const match of xml.matchAll(/<PlanAffectingConvert\b[^>]*>/g)) {
    warnings.push(`Implicit conversion (${attr(match[0], "ConvertIssue") ?? "?"}): ${xmlText(attr(match[0], "Expression") ?? "").slice(0, 200)}`);
  }
  if (/<NoJoinPredicate\b/.test(xml)) warnings.push("A join has no join predicate (cartesian product).");
  for (const match of xml.matchAll(/<SpillToTempDb\b[^>]*>/g)) warnings.push(`Spill to tempdb (level ${attr(match[0], "SpillLevel") ?? "?"}).`);
  if (/<MemoryGrantWarning\b/.test(xml)) warnings.push("Memory grant warning.");
  if (warnings.length) lines.push("", "Engine warnings:", ...[...new Set(warnings)].map((warning) => `- ${warning}`));

  const missing: string[] = [];
  for (const group of xml.matchAll(/<MissingIndexGroup\b[^>]*Impact="([\d.]+)"[^>]*>([\s\S]*?)<\/MissingIndexGroup>/g)) {
    const index = /<MissingIndex\b[^>]*>/.exec(group[2])?.[0] ?? "";
    const table = [attr(index, "Schema"), attr(index, "Table")].filter(Boolean).map((part) => part?.replace(/[[\]]/g, "")).join(".");
    const columns = (usage: string) =>
      [...(new RegExp(`<ColumnGroup\\b[^>]*Usage="${usage}"[^>]*>([\\s\\S]*?)</ColumnGroup>`).exec(group[2])?.[1] ?? "").matchAll(/<Column\b[^>]*Name="([^"]+)"/g)]
        .map((m) => m[1].replace(/[[\]]/g, ""));
    const keys = [...columns("EQUALITY"), ...columns("INEQUALITY")];
    const include = columns("INCLUDE");
    missing.push(`- ${table} (${keys.join(", ")})${include.length ? ` include (${include.join(", ")})` : ""} — estimated impact ${group[1]}%`);
  }
  if (missing.length) lines.push("", "Missing indexes the engine reports (check existing ones first):", ...missing);

  return { format: "sqlserver-xml", dialect: "sqlserver", text: cap(lines.join("\n")), operators: ops.length };
}

// --- PostgreSQL EXPLAIN (FORMAT JSON) ----------------------------------------

function postgresJson(root: Record<string, unknown>): PlanSummary {
  type Node = Record<string, unknown> & { Plans?: Node[] };
  const nodes: { node: Node; own: number }[] = [];
  const walk = (node: Node) => {
    const children = node.Plans ?? [];
    const childCost = children.reduce((sum, child) => sum + Number(child["Total Cost"] ?? 0), 0);
    const childTime = children.reduce((sum, child) => sum + Number(child["Actual Total Time"] ?? 0) * Number(child["Actual Loops"] ?? 1), 0);
    const timed = node["Actual Total Time"] !== undefined;
    const own = timed
      ? Number(node["Actual Total Time"]) * Number(node["Actual Loops"] ?? 1) - childTime
      : Number(node["Total Cost"] ?? 0) - childCost;
    nodes.push({ node, own: Math.max(0, own) });
    children.forEach(walk);
  };
  const plan = root.Plan as Node;
  walk(plan);
  const timed = plan["Actual Total Time"] !== undefined;
  const total = nodes.reduce((sum, entry) => sum + entry.own, 0) || 1;
  const lines = [
    timed
      ? `Measured plan (EXPLAIN ANALYZE): execution ${round(Number(root["Execution Time"] ?? plan["Actual Total Time"]))} ms, planning ${round(Number(root["Planning Time"] ?? 0))} ms.`
      : `Estimated plan: total cost ${round(Number(plan["Total Cost"] ?? 0))}.`,
    "",
    `Most expensive nodes (own ${timed ? "time" : "cost"}):`,
  ];
  for (const { node, own } of [...nodes].sort((a, b) => b.own - a.own).slice(0, MAX_HOTSPOTS)) {
    const type = String(node["Node Type"] ?? "?");
    const relation = node["Relation Name"] ? ` on ${node["Relation Name"]}` : "";
    const index = node["Index Name"] ? ` using ${node["Index Name"]}` : "";
    const rows = Number(node["Plan Rows"] ?? 0);
    const actual = node["Actual Rows"] !== undefined ? Number(node["Actual Rows"]) : undefined;
    const loops = Number(node["Actual Loops"] ?? 1);
    const filter = node.Filter ? ` filter ${String(node.Filter).slice(0, 160)}` : "";
    const removed = node["Rows Removed by Filter"] ? ` (removed ${node["Rows Removed by Filter"]} rows)` : "";
    const scan = type === "Seq Scan" ? " [FULL SCAN]" : "";
    const off =
      actual !== undefined && rows > 0 && (actual / rows > 10 || rows / Math.max(actual, 1) > 10) ? ` [ESTIMATE OFF: est ${rows} vs actual ${actual}]` : "";
    lines.push(
      `- ${type}${relation}${index}: ${pct(own, total)} of ${timed ? "time" : "cost"}, est rows ${rows}${actual !== undefined ? `, actual ${actual}${loops > 1 ? ` x ${loops} loops` : ""}` : ""}${filter}${removed}${scan}${off}`,
    );
  }
  return { format: "postgresql-json", dialect: "postgresql", text: cap(lines.join("\n")), operators: nodes.length };
}

// --- MySQL EXPLAIN FORMAT=JSON ------------------------------------------------

function mysqlJson(root: Record<string, unknown>): PlanSummary {
  const tables: Record<string, unknown>[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.table && typeof record.table === "object" && "table_name" in (record.table as object)) tables.push(record.table as Record<string, unknown>);
    for (const child of Object.values(record)) walk(child);
  };
  walk(root);
  const queryCost = (root.query_block as Record<string, unknown> | undefined)?.cost_info as Record<string, unknown> | undefined;
  const lines = [`Estimated query cost ${queryCost?.query_cost ?? "?"}.`, "", "Tables in plan order:"];
  for (const table of tables) {
    const access = String(table.access_type ?? "?");
    const cost = table.cost_info as Record<string, unknown> | undefined;
    lines.push(
      `- ${table.table_name}: access ${access}${access === "ALL" ? " [FULL SCAN]" : ""}, key ${table.key ?? "none"}${
        table.possible_keys ? ` (possible: ${(table.possible_keys as string[]).join(", ")})` : ""
      }, rows examined ${table.rows_examined_per_scan ?? "?"}, filtered ${table.filtered ?? "?"}%${cost?.prefix_cost ? `, prefix cost ${cost.prefix_cost}` : ""}${
        table.attached_condition ? `, condition ${String(table.attached_condition).slice(0, 160)}` : ""
      }`,
    );
  }
  return { format: "mysql-json", dialect: "mysql", text: cap(lines.join("\n")), operators: tables.length };
}

// --- Any text plan ------------------------------------------------------------

function plainText(text: string): PlanSummary {
  const lines = text.split(/\r?\n/);
  const marked = lines.map((line) => (/\bSeq Scan\b|\bTable Scan\b|\bClustered Index Scan\b|\btype:\s*ALL\b|\|\s*ALL\s*\|/i.test(line) ? `${line}   <-- FULL SCAN` : line));
  return { format: "text", text: cap(marked.join("\n")), operators: lines.filter((line) => line.trim()).length };
}

function round(value: number): string {
  return Number.isFinite(value) ? (Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2).replace(/\.?0+$/, "")) : "?";
}

function pct(part: number, total: number): string {
  return `${total > 0 ? Math.round((part / total) * 100) : 0}%`;
}

function cap(text: string): string {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n… (plan summary cut at ${MAX_TEXT_CHARS} characters)` : text;
}
