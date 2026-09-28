import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Best-effort check for whether `--project` (clone mode's target) has its own
 * build manifest — one of the ecosystems the Clone Build stage
 * (`stages/clone-build.ts`) already knows how to build: Maven, Gradle,
 * npm/pnpm/yarn, dotnet, make.
 *
 * Why this matters: narrowing `--project` to the exact module being ported
 * into (instead of a whole monorepo root) cuts down what Clone
 * Conventions/Mapping/Coding have to explore — the SDK scopes file access to
 * the working directory (see `reference-repos.ts`), so a narrower path is
 * fewer turns and fewer tokens, the same principle `--from`'s existing
 * guidance already applies to the source side. But narrowed past the
 * project's own build boundary, Clone Build has nothing to build from in that
 * directory, and the run fails late — after Locate, Conventions, Mapping and
 * every Port group already ran and were paid for.
 *
 * This is advisory, not a gate: an ecosystem this heuristic doesn't recognise
 * can still build fine (a workspace root one level up that this doesn't check
 * for, a custom build script, `--no-build` runs), so a miss here only warns —
 * it never blocks the run.
 */
const BUILD_MANIFEST_FILENAMES = ["package.json", "pom.xml", "build.gradle", "build.gradle.kts", "Makefile"];
const DOTNET_PROJECT_FILE_PATTERN = /\.(csproj|sln)$/i;

export function hasOwnBuildManifest(projectPath: string): boolean {
  if (BUILD_MANIFEST_FILENAMES.some((name) => existsSync(path.join(projectPath, name)))) return true;

  try {
    return readdirSync(projectPath).some((entry) => DOTNET_PROJECT_FILE_PATTERN.test(entry));
  } catch {
    // Unreadable directory is a different, earlier failure (caught by
    // resolveReferencePaths' existence check) — nothing more to say here.
    return false;
  }
}

/** null when the project has its own build manifest, or the check found nothing to look at. */
export function missingBuildManifestWarning(projectPath: string): string | null {
  if (hasOwnBuildManifest(projectPath)) return null;

  return (
    `Target folder ${projectPath} has no build manifest of its own ` +
    "(no package.json, pom.xml, build.gradle[.kts], Makefile, or *.csproj/*.sln found there). " +
    "The Clone Build stage builds from this exact folder at the end of the run — if the real " +
    "build root is a parent folder, point the target folder there or pass --no-build."
  );
}
