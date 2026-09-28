import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { rootPath, type ProjectRoot } from "./target-roots.js";
import type { CloneCoverage, CloneDeviation, CloneMapping, CloneMappingEntry } from "./types.js";

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
export function checkCoverage(
  mapping: CloneMapping,
  target: string | ProjectRoot[],
  deviations: CloneDeviation[] = [],
): CloneCoverage {
  const roots: ProjectRoot[] = typeof target === "string" ? [{ role: "app", path: target }] : target;
  const declared = new Map(deviations.map((deviation) => [deviation.target, deviation]));
  const declaredByPath = new Map(
    deviations.filter((deviation) => path.isAbsolute(deviation.target)).map((d) => [path.resolve(d.target), d]),
  );
  const present: string[] = [];
  const missing: string[] = [];
  const merged: CloneDeviation[] = [];
  const excluded: CloneMappingEntry[] = [];

  for (const entry of mapping.entries) {
    // A mapping-time decision, not a forgotten file — never checked against
    // the filesystem, never counted missing. See CloneMappingEntry.notPorted.
    if (entry.notPorted) {
      excluded.push(entry);
      continue;
    }

    // Each entry is relative to the target folder its `root` names (BE or FE
    // for a split project); with one folder, that folder.
    const folder = rootPath(roots, entry.root);
    if (isFile(path.resolve(folder, entry.target))) {
      present.push(entry.target);
      continue;
    }

    // Not at the promised path. A declared deviation only counts when the
    // filesystem backs it: a merge needs its coveredBy file to exist. Anything
    // else — undeclared, "not-needed", or a merge into nothing — is missing.
    // The port agent may name the file as the mapping does or, with split
    // folders, by the absolute path it was given — accept either.
    const deviation = declared.get(entry.target) ?? declaredByPath.get(path.resolve(folder, entry.target));
    if (deviation?.kind === "merged" && deviation.coveredBy && isFile(path.resolve(folder, deviation.coveredBy))) {
      merged.push(deviation);
    } else {
      missing.push(entry.target);
    }
  }

  return { present, missing, merged, excluded };
}

function isFile(file: string): boolean {
  return existsSync(file) && statSync(file).isFile();
}

/** One line for the progress stream and the final message. */
export function describeCoverage(coverage: CloneCoverage): string {
  const merged = coverage.merged?.length ?? 0;
  const excluded = coverage.excluded?.length ?? 0;
  const total = coverage.present.length + coverage.missing.length + merged;
  const notes = [
    merged ? `${merged} merged into other files` : null,
    // Not part of the X/Y fraction — these were never promised, so they never
    // needed writing, and counting them in `total` would make the fraction
    // read like fewer files were delivered than actually were.
    excluded ? `${excluded} intentionally not ported` : null,
  ].filter(Boolean);
  return `${coverage.present.length}/${total} file(s) present${notes.length ? ` (${notes.join(", ")})` : ""}`;
}
