import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { runStructuredQuery } from "../sdk-helpers.js";
import { config, networkExfilBashBlocklist } from "../config.js";
import { runtimePortsPromptSection } from "../prompts/runtime-ports.js";
import { isSplit, rootPath, secondaryRootDirs, type ProjectRoot } from "../target-roots.js";
import type { CloneMapping } from "../types.js";

/**
 * Compiles what was just ported, and reports whether it builds.
 *
 * This replaces the E2E stage for clone runs. A freshly ported feature usually
 * cannot run yet — no database rows, no config, no wiring into a live
 * environment — so demanding a passing browser test would fail runs whose port
 * was in fact correct and complete. "Does it compile" is the strongest signal
 * available at this point, and unlike a browser run it is about the code that
 * was written rather than the environment around it.
 *
 * Read-only against the source tree: it may run the build and read output, but
 * it does not get Write or Edit. A stage that could fix the code it is judging
 * would be judging its own work — the same separation the E2E stage keeps.
 */

const SYSTEM_PROMPT = `You are the Clone Build agent in an automated port pipeline.
Ported files have just been written into the target project. Find out whether
the project still builds, and report honestly.

1. Work out how this project builds from its own build files (Maven, Gradle,
   npm/pnpm/yarn, dotnet, make). Prefer compiling only the modules or packages
   that were touched; fall back to a full build if scoping is not obvious.
2. Run it, and read the output. For a TypeScript client, also run the type
   check (\`tsc --noEmit\` with the project's own config, or its tsc/lint
   script): a bundler build can pass while imports and types are broken.
3. Judge only what this port did. The project may already fail to build for
   reasons unrelated to it. An error counts against the port if it is in one of
   the ported files listed below, or in another file because of one (a ported
   symbol it uses, a route file that registers a ported page). Errors only in
   untouched files are pre-existing: they do not fail the verdict, but say how
   many there were in summary. If you cannot tell which errors are new, report
   ok=false and say why rather than guessing.
4. Report the verdict, and for a failure quote the actual compiler or bundler
   errors that count — file and message — rather than summarising them away.

You cannot edit any file. Do not attempt to fix what you find; your job is the
verdict, and someone else acts on it. If you cannot determine a build command
at all, report ok=false with the reason — that is an honest "unknown", and a
run that could not be checked must not be reported as one that passed.`;

const BUILD_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    command: { type: "string" },
    summary: { type: "string" },
    errors: { type: "array", items: { type: "string" } },
  },
  required: ["ok", "summary"],
};

export interface CloneBuildVerdict {
  ok: boolean;
  command?: string;
  summary: string;
  errors?: string[];
}

export async function verifyCloneBuild(
  mapping: CloneMapping,
  runtimePorts: number[] = [],
  roots: ProjectRoot[] = [],
): Promise<CloneBuildVerdict> {
  const options: Options = {
    systemPrompt: SYSTEM_PROMPT,
    allowedTools: ["Read", "Glob", "Grep", "Bash"],
    disallowedTools: [
      "Bash(git commit*)",
      "Bash(git push*)",
      "Bash(git branch*)",
      "Bash(git checkout*)",
      ...networkExfilBashBlocklist,
    ],
    // No Write/Edit, and canUseTool denies them outright: this stage judges the
    // port, so it must not be able to patch the port to make itself pass.
    canUseTool: async (toolName) => ({
      behavior: "deny",
      message: `Tool "${toolName}" is not permitted in the Clone Build stage — it reports, it does not fix.`,
    }),
    model: config.model,
    maxTurns: config.maxTurns.cloneBuild,
  };

  const split = isSplit(roots);
  const secondary = secondaryRootDirs(roots);
  if (secondary.length) options.additionalDirectories = secondary;

  const prompt = [
    ...(split ? filesByFolder(mapping, roots) : ["--- Files just ported into this project ---", ...mapping.entries.map((entry) => `- ${entry.target}`)]),
    "",
    split
      ? "BE and FE are separate projects with their own builds. Build every folder above that received files (cd into each), and report one verdict: ok only if every one of them builds, with each folder's errors quoted."
      : "Determine how this project builds, build what these files affect, and report.",
    // A build normally starts no server, but a check that boots the app (a
    // Spring context test, a dev server) must not assume a default port.
    ...runtimePortsPromptSection(runtimePorts),
  ].join("\n");

  const result = await runStructuredQuery<CloneBuildVerdict>(prompt, options, BUILD_SCHEMA);
  if (!result.ok || !result.data) {
    // Fail-closed: an unavailable verdict is "not verified", never "fine".
    return {
      ok: false,
      summary: `Build check produced no verdict: ${result.error ?? "unknown error"}`,
    };
  }
  return result.data;
}

function filesByFolder(mapping: CloneMapping, roots: ProjectRoot[]): string[] {
  const lines: string[] = [];
  for (const root of roots) {
    const files = mapping.entries.filter((entry) => rootPath(roots, entry.root) === root.path);
    if (!files.length) continue;
    lines.push(`--- Files just ported into ${root.role.toUpperCase()} (${root.path}) ---`);
    lines.push(...files.map((entry) => `- ${entry.target}`), "");
  }
  return lines;
}
