/**
 * Splits a large SQL file into parts the optimizer can send one at a time, by
 * plain code. The parts are contiguous slices: joined back in order they are
 * the original text byte for byte, so edits made inside each part reassemble
 * into one file.
 *
 * Boundaries, in order of preference: a routine definition (CREATE/ALTER
 * PROCEDURE/FUNCTION/TRIGGER/VIEW, with the comment block right above it) and
 * a batch separator (GO, DELIMITER). Small neighbouring units are merged up to
 * `CHUNK_TARGET_CHARS`, so a file of many short procedures does not cost one
 * model call each. A single unit larger than `CHUNK_MAX_CHARS` — one huge
 * procedure — is cut at statement ends (a line ending in `;`, or a blank
 * line); each later piece carries the routine's header and DECLARE lines as
 * read-only context, so the model knows the parameters and variables it uses.
 */

export const CHUNK_TARGET_CHARS = 60_000;
export const CHUNK_MAX_CHARS = 150_000;
const MAX_CONTEXT_CHARS = 6_000;

export interface SqlChunk {
  start: number;
  end: number;
  /** Routine name(s) or line range, for progress lines and step labels. */
  label: string;
  /** Read-only lines from the routine this piece is cut from (header, declarations). */
  context?: string;
}

const ROUTINE_START = /^\s*(CREATE|ALTER)\s+(OR\s+(ALTER|REPLACE)\s+)?(PROC|PROCEDURE|FUNCTION|TRIGGER|VIEW)\s+([^\s(]+)/i;
const BATCH_END = /^\s*(GO|DELIMITER\b.*)\s*$/i;

interface Line {
  start: number;
  end: number;
  text: string;
}

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline + 1;
    lines.push({ start, end, text: text.slice(start, end).replace(/\r?\n$/, "") });
    start = end;
  }
  return lines;
}

const lineNumberAt = (text: string, offset: number) => text.slice(0, offset).split("\n").length;

export function splitSqlChunks(text: string): SqlChunk[] {
  if (text.length <= CHUNK_TARGET_CHARS) return [{ start: 0, end: text.length, label: "whole file" }];
  const lines = linesOf(text);

  // 1. Units: a routine starts a unit (with the comment lines right above it); a batch separator ends one.
  const cuts = new Set<number>([0]);
  for (const [i, line] of lines.entries()) {
    if (ROUTINE_START.test(line.text)) {
      let first = i;
      while (first > 0 && /^\s*--/.test(lines[first - 1].text)) first--;
      cuts.add(lines[first].start);
    }
    if (BATCH_END.test(line.text) && i + 1 < lines.length) cuts.add(lines[i + 1].start);
  }
  const starts = [...cuts].sort((a, b) => a - b);
  const units = starts.map((start, i) => ({ start, end: starts[i + 1] ?? text.length }));

  // 2. Merge small neighbours up to the target size.
  const merged: { start: number; end: number }[] = [];
  for (const unit of units) {
    const last = merged.at(-1);
    if (last && unit.end - last.start <= CHUNK_TARGET_CHARS) last.end = unit.end;
    else merged.push({ ...unit });
  }

  // 3. Cut any unit still too large at statement ends, giving later pieces the routine's context.
  const chunks: SqlChunk[] = [];
  for (const unit of merged) {
    const body = text.slice(unit.start, unit.end);
    const names = [...body.matchAll(new RegExp(ROUTINE_START.source, "gim"))].map((match) => match[5]);
    const label = names.length ? names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : "") : `lines ${lineNumberAt(text, unit.start)}–${lineNumberAt(text, unit.end - 1)}`;
    if (unit.end - unit.start <= CHUNK_MAX_CHARS) {
      chunks.push({ ...unit, label });
      continue;
    }
    const unitLines = lines.filter((line) => line.start >= unit.start && line.end <= unit.end);
    const context = routineContext(unitLines);
    let pieceStart = unit.start;
    let piece = 1;
    while (pieceStart < unit.end) {
      let pieceEnd = Math.min(unit.end, pieceStart + CHUNK_MAX_CHARS);
      if (pieceEnd < unit.end) {
        // The last statement end in the window's final fifth, else the last line end.
        const window = unitLines.filter((line) => line.end > pieceStart && line.end <= pieceEnd);
        const statementEnd = [...window].reverse().find((line) => line.end - pieceStart >= CHUNK_MAX_CHARS * 0.8 && /;\s*$|^\s*$/.test(line.text));
        pieceEnd = (statementEnd ?? window.at(-1))?.end ?? pieceEnd;
        if (pieceEnd <= pieceStart) pieceEnd = Math.min(unit.end, pieceStart + CHUNK_MAX_CHARS);
      }
      chunks.push({
        start: pieceStart,
        end: pieceEnd,
        label: `${label} (piece ${piece}, lines ${lineNumberAt(text, pieceStart)}–${lineNumberAt(text, pieceEnd - 1)})`,
        ...(piece > 1 && context ? { context } : {}),
      });
      pieceStart = pieceEnd;
      piece++;
    }
  }
  return chunks;
}

/** A routine's signature (up to its AS/BEGIN/LANGUAGE line) and every DECLARE line, capped. */
function routineContext(lines: Line[]): string {
  const header: string[] = [];
  for (const line of lines.slice(0, 60)) {
    header.push(line.text);
    if (/^\s*(AS|BEGIN|IS)\b|\bLANGUAGE\b|\$\$\s*$/i.test(line.text)) break;
  }
  const declares = lines.filter((line) => /^\s*DECLARE\b/i.test(line.text)).map((line) => line.text);
  const text = [...header, ...(declares.length ? ["-- declarations in this routine:", ...declares] : [])].join("\n");
  return text.length > MAX_CONTEXT_CHARS ? `${text.slice(0, MAX_CONTEXT_CHARS)}\n-- (context cut)` : text;
}
