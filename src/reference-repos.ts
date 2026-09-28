import path from "node:path";
import { secondaryRootDirs, type ProjectRoot } from "./target-roots.js";
import type { ReferenceInventory } from "./types.js";

/**
 * Support for `--reference <dir>`: source trees the agents may read but must
 * not touch, so a spec can say "clone this screen from the sample project"
 * instead of pasting the sample's code into the spec document.
 *
 * Why this needs explicit support at all: `src/index.ts` chdirs into the
 * target project, and the Agent SDK scopes file access to the working
 * directory. A reference repo sitting anywhere else is simply invisible until
 * it is passed as `additionalDirectories` — the SDK's own escape hatch for
 * "directories Claude can access beyond the current working directory".
 *
 * That option grants read *and* write, which is not what "reference" means
 * here, so the Coding stage pairs it with a `canUseTool` guard (see
 * `stages/coding.ts`). Both halves are required: the directory list opens the
 * door, the guard keeps output from going through it.
 */

/** Absolute reference directories, or an empty list when none were given. */
export function referenceDirectories(referencePaths: string[] | undefined): string[] {
  return (referencePaths ?? []).map((candidate) => path.resolve(candidate));
}

/**
 * Every directory a stage needs opened on top of its working directory: the
 * reference repos (read-only — writes into them are guarded separately) and
 * any target folder beyond the first, e.g. FE when BE is the working directory.
 */
export function extraDirectories(referencePaths: string[] | undefined, roots: ProjectRoot[]): string[] {
  return [...referenceDirectories(referencePaths), ...secondaryRootDirs(roots)];
}

/**
 * Prompt block naming the reference repos, plus the inventory when one was
 * produced. Nothing at all when there are no reference repos, so a run without
 * them reads exactly as it did before the flag existed.
 */
export function referencePromptSection(
  referencePaths: string[] | undefined,
  inventory?: ReferenceInventory | null,
): string[] {
  const directories = referenceDirectories(referencePaths);
  if (!directories.length) return [];

  const section = [
    "",
    "--- Reference repositories (READ-ONLY) ---",
    ...directories,
    "",
    "Read these to copy existing patterns, structure, naming and logic from — that",
    "is what they are for. They are NOT the target: every file you create or edit",
    "belongs in the target project (the current working directory). Do not create,",
    "edit or delete anything inside a reference repository, and do not run commands",
    "that modify one.",
  ];

  if (inventory?.files.length) {
    section.push(
      "",
      "--- Reference files already inventoried (relative to the reference root) ---",
      ...inventory.files.map((file) => `- ${file.path} — ${file.role}`),
    );
    if (inventory.notes.trim()) section.push("", `Inventory notes: ${inventory.notes.trim()}`);
    section.push(
      "",
      "This list was produced by a stage whose only job was to find these files.",
      "Treat it as the checklist of what to cover: work through it rather than",
      "re-deciding for yourself which parts of the reference matter. Read a file",
      "not on the list if you need it — but do not silently skip one that is.",
    );
  }

  return section;
}

/**
 * Whether a path resolves to a reference repo or something inside one.
 *
 * `path.relative` rather than a string prefix test, so `…/sample-evil` is not
 * mistaken for a child of `…/sample`, and `sample/../../etc` cannot slip
 * through. On Windows the comparison is case-insensitive, which is what the
 * filesystem does anyway.
 */
export function isInsideReference(filePath: string, referencePaths: string[] | undefined): boolean {
  if (!filePath) return false;
  const target = path.resolve(filePath);

  return referenceDirectories(referencePaths).some((directory) => {
    const relative = path.relative(directory, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}
