import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { CloneCoverage, CloneMapping } from "./types.js";

/**
 * Checks the mapping against the filesystem: every file the mapping promised
 * to produce, is it actually there?
 *
 * Deliberately not an agent. "Did the clone miss anything" is the one question
 * in this pipeline with a mechanical answer, and a mechanical answer is worth
 * more than a model's opinion of its own work — a model that forgot to write a
 * file is exactly the model least likely to notice.
 *
 * What it proves and what it does not: a present file means something was
 * written at that path, not that the contents are right, and not that the
 * mapping named the right path in the first place. A file put in a plausible
 * but wrong module passes this check. That limit is why the mapping is shown
 * to the user rather than kept in the log.
 */
export function checkCoverage(mapping: CloneMapping, projectPath: string): CloneCoverage {
  const present: string[] = [];
  const missing: string[] = [];

  for (const entry of mapping.entries) {
    const target = path.resolve(projectPath, entry.target);
    if (existsSync(target) && statSync(target).isFile()) present.push(entry.target);
    else missing.push(entry.target);
  }

  return { present, missing };
}

/** One line for the progress stream and the final message. */
export function describeCoverage(coverage: CloneCoverage): string {
  const total = coverage.present.length + coverage.missing.length;
  return `${coverage.present.length}/${total} file(s) present`;
}
