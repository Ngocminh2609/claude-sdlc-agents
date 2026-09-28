import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { runStructuredQuery } from "../sdk-helpers.js";
import { config, networkExfilBashBlocklist } from "../config.js";
import { projectContextPromptSection } from "./project-context.js";
import { runtimePortsPromptSection } from "../prompts/runtime-ports.js";
import { skillCatalogPromptSection, withSkillDirs } from "../skills-catalog.js";
import { rootsOf, secondaryRootDirs, targetRootsPromptSection } from "../target-roots.js";
import type { E2eVerdict, ProjectContext, SpecInput } from "../types.js";

const SYSTEM_PROMPT = `You are the E2E/QA agent in an automated SDLC pipeline.
Independently verify the implementation against the ORIGINAL spec by actually
running the project and driving it through a real browser — not by reading
the developer's claims.

1. Work out how to start the WHOLE app from its own build and run files
   (package.json, pom.xml, build.gradle, README, ...). An app can need more
   than one server — e.g. a Spring Boot API plus a Vite frontend — and every
   one of them must be running for a browser test to mean anything.
2. If Playwright isn't already set up, install it (@playwright/test) and
   install browser binaries, then create/update playwright.config with a
   "webServer" entry for EACH server the app needs (webServer accepts an
   array), so Playwright starts all of them itself and waits for each to be
   ready before running tests. Use the free ports you are given below.
3. Write your OWN Playwright test files (do not trust or reuse tests the
   Coding agent wrote) under an "e2e/" directory, covering every acceptance
   criterion in the spec by driving the real user flows through the browser.
4. Run "${config.playwrightTestCommand}" and read the results.
5. Map every acceptance criterion to concrete evidence (the Playwright test
   name that exercises it). A criterion with no covering test must be marked
   covered=false.

You may only write files under an "e2e/" directory, files named "*.spec.ts"
or "*.spec.js", or a "playwright.config" file — you cannot edit application
source. You are reporting defects, not fixing them.`;

const E2E_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    summary: { type: "string" },
    acceptanceCriteria: {
      type: "array",
      items: {
        type: "object",
        properties: {
          criterion: { type: "string" },
          covered: { type: "boolean" },
          evidence: { type: "string" },
        },
        required: ["criterion", "covered", "evidence"],
      },
    },
    failedScenarios: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "summary"],
};

const TEST_FILE_PATTERN = /(^|[\\/])e2e[\\/]|\.spec\.[jt]sx?$|playwright\.config\.[cm]?[jt]s$/;

type CanUseTool = NonNullable<Options["canUseTool"]>;

// Real signature per node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:
// (toolName, input, options) => Promise<PermissionResult | null>. This
// differs from the (request, response)-callback shape shown in the public
// docs at the time this was written — the shipped .d.ts is the ground truth.
const restrictWritesToE2eFiles: CanUseTool = async (toolName, input) => {
  if (toolName === "Write" || toolName === "Edit") {
    const filePath = String((input as { file_path?: string }).file_path ?? "");
    if (TEST_FILE_PATTERN.test(filePath)) {
      return { behavior: "allow" };
    }
    return {
      behavior: "deny",
      message: "The E2E stage may only write test files (e2e/, *.spec.ts, playwright.config) — not application source.",
    };
  }
  return { behavior: "deny", message: `Tool "${toolName}" is not permitted in the E2E stage.` };
};

export async function runE2eTest(
  spec: SpecInput,
  approvedProposal: string,
  projectContext?: ProjectContext | null,
  runtimePorts: number[] = [],
): Promise<E2eVerdict> {
  // Deliberately a fresh query() call (no continue/resume) so this stage has
  // no memory of the Coding stage's own session — independent verification.
  // Write/Edit are intentionally NOT in allowedTools: they are gated by
  // canUseTool instead, so the SDK's "allowedTools bypasses canUseTool"
  // behavior can't be used to sneak app-source edits past the path check.
  const options: Options = {
    systemPrompt: SYSTEM_PROMPT,
    allowedTools: ["Read", "Glob", "Grep", "Bash"],
    disallowedTools: [...networkExfilBashBlocklist],
    canUseTool: restrictWritesToE2eFiles,
    model: config.model,
    maxTurns: config.maxTurns.e2e,
  };

  // Separate BE/FE folders: both servers have to be started, so both folders
  // are opened. Writes stay limited to test files by canUseTool either way.
  const roots = rootsOf(spec);
  const secondary = withSkillDirs(secondaryRootDirs(roots), spec.skillCatalog);
  if (secondary.length) options.additionalDirectories = secondary;

  const prompt = [
    "--- Spec ---",
    spec.specMarkdown,
    ...targetRootsPromptSection(roots),
    "",
    "--- Approved design (what the implementation should satisfy) ---",
    approvedProposal,
    // Only the "how this project is organised/started" half — the
    // relevant-files list is a coding concern and would blur this stage's
    // independence from what the Coding stage claims to have done.
    ...projectContextPromptSection(projectContext, { includeRelevantFiles: false }),
    ...skillCatalogPromptSection(spec.skillCatalog),
    ...runtimePortsPromptSection(runtimePorts),
  ].join("\n");

  const result = await runStructuredQuery<E2eVerdict>(prompt, options, E2E_SCHEMA);
  if (!result.ok || !result.data) {
    // Fail-closed: an unparseable/unavailable verdict is treated as a fail,
    // not a silent pass.
    return {
      verdict: "fail",
      summary: `E2E stage failed to produce a verdict: ${result.error ?? "unknown error"}`,
    };
  }
  return result.data;
}
