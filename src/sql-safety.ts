/**
 * Plain-code checks on a SQL script before the pipeline runs it against a
 * real database. No model involved: whether a script may run is decided here,
 * the same way `checkCoverage` decides coverage — deterministically.
 *
 * The rule (user decision, 2026-10-05): a feature run creates schema in an
 * empty or near-empty database, so a script that drops, truncates or deletes
 * is refused rather than run. Only top-level statements count. A stored
 * procedure or function whose body deletes rows is a definition, not a
 * deletion, and creating it is allowed.
 */

/**
 * Replaces comments, string/identifier literals and PostgreSQL dollar-quoted
 * bodies with spaces (newlines kept, so `GO` lines stay on their own line).
 * What is left is the statement skeleton the checks below read.
 */
export function stripSqlNoise(sql: string): string {
  let out = "";
  let i = 0;
  const blank = (text: string) => text.replace(/[^\n]/g, " ");

  while (i < sql.length) {
    const rest = sql.slice(i);
    let match: RegExpMatchArray | null;

    if (rest.startsWith("--")) {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      out += blank(sql.slice(i, stop));
      i = stop;
    } else if (rest.startsWith("/*")) {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += blank(sql.slice(i, stop));
      i = stop;
    } else if ((match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest))) {
      const tag = match[0];
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end === -1 ? sql.length : end + tag.length;
      out += blank(sql.slice(i, stop));
      i = stop;
    } else if (rest[0] === "'" || rest[0] === '"' || rest[0] === "`" || rest[0] === "[") {
      const close = rest[0] === "[" ? "]" : rest[0];
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === close) {
          // A doubled quote is an escaped quote, not the end of the literal.
          if (sql[j + 1] === close && close !== "]") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      const stop = Math.min(j + 1, sql.length);
      out += blank(sql.slice(i, stop));
      i = stop;
    } else {
      out += sql[i];
      i++;
    }
  }
  return out;
}

/**
 * Top-level statements, split on `;` and on SQL Server `GO` lines, but never
 * inside a BEGIN…END or CASE…END block — that is a routine body or an
 * expression, and its inner statements are not the script's own.
 */
export function topLevelStatements(sql: string): string[] {
  const skeleton = stripSqlNoise(sql);
  const statements: string[] = [];
  // `BEGIN;` / `BEGIN TRANSACTION` start a transaction, not a block.
  const token = /\bBEGIN\b(?!\s*;|\s+(?:TRAN|TRANSACTION|WORK|DISTRIBUTED|ISOLATION)\b)|\bCASE\b|\bEND\b(\s+(?:IF|WHILE|LOOP|REPEAT)\b)?|;|^[ \t]*GO[ \t]*\d*[ \t]*$/gim;
  let depth = 0;
  let start = 0;
  let match: RegExpExecArray | null;

  const cut = (end: number) => {
    const text = skeleton.slice(start, end).trim();
    if (text) statements.push(text);
  };

  while ((match = token.exec(skeleton))) {
    const word = match[0].trim().toUpperCase();
    if (word === "BEGIN" || word === "CASE") depth++;
    else if (word.startsWith("END")) {
      // END IF / END WHILE / ... close a control block that never opened one here.
      if (!match[1]) depth = Math.max(0, depth - 1);
    } else if (depth === 0) {
      cut(match.index);
      start = match.index + match[0].length;
    }
  }
  cut(skeleton.length);
  return statements;
}

/** Statements that define a routine: their bodies may delete rows without the script doing so. */
const ROUTINE_DEFINITION = /^(CREATE|ALTER)\s+(OR\s+(REPLACE|ALTER)\s+)?(DEFINER\s*=\s*\S+\s+)?(PROCEDURE|PROC|FUNCTION|TRIGGER|PACKAGE)\b/i;

/** Permission statements name DELETE as a privilege, not as an action. */
const PERMISSION_STATEMENT = /^(GRANT|REVOKE|DENY)\b/i;

/**
 * Matched anywhere in a statement, not only at its start: SQL Server scripts
 * commonly guard a drop (`IF OBJECT_ID('t') IS NOT NULL DROP TABLE t`).
 */
const DESTRUCTIVE = [
  /\bTRUNCATE\b/i,
  // Dropping a table, column or constraint destroys data; dropping NOT NULL or a default does not.
  /\bDROP\b(?!\s+(NOT\s+NULL|DEFAULT|IDENTITY|EXPRESSION)\b)/i,
  // `ON DELETE CASCADE` in a foreign key, and trigger/policy events, are not deletions.
  /(?<!\b(ON|FOR|AFTER|BEFORE|INSTEAD\s+OF)\s+)\bDELETE\b/i,
];

/**
 * The first destructive top-level statement, shortened for a message, or null
 * when the script only creates and inserts.
 */
export function findDestructiveStatement(sql: string): string | null {
  for (const statement of topLevelStatements(sql)) {
    const flat = statement.replace(/\s+/g, " ");
    if (ROUTINE_DEFINITION.test(flat) || PERMISSION_STATEMENT.test(flat)) continue;
    if (DESTRUCTIVE.some((pattern) => pattern.test(flat))) {
      return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
    }
  }
  return null;
}

/** SQL Server sends a script batch by batch, cut at `GO` lines the server itself does not understand. */
export function splitGoBatches(sql: string): string[] {
  return sql
    .split(/^[ \t]*GO[ \t]*\d*[ \t]*$/gim)
    .map((batch) => batch.trim())
    .filter(Boolean);
}
