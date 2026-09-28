import path from "node:path";
import type { CanUseTool, Options } from "@anthropic-ai/claude-agent-sdk";
import { runStructuredQuery } from "../sdk-helpers.js";
import { config, networkExfilBashBlocklist } from "../config.js";
import { runtimePortsPromptSection } from "../prompts/runtime-ports.js";
import { indexPromptSection, withIndexAccess } from "../project-index.js";
import { isInsideReference } from "../reference-repos.js";
import { isTestFile } from "../test-files.js";
import { isSplit, rootPath, secondaryRootDirs, targetRootsPromptSection, type ProjectRoot } from "../target-roots.js";
import type { CloneInput, CloneMapping, CloneTestVerdict, TargetConventions } from "../types.js";
import { layerOf } from "./clone-port.js";

/**
 * Writes and runs unit tests for the ported feature's basic CRUD flow.
 *
 * Coverage says the files exist, wiring says the client reaches the server,
 * the build says it compiles. None of those says "create, read, update,
 * delete and search actually go through". This stage checks that path at the
 * cheapest level that still exercises the ported code: server controllers and
 * services with their collaborators mocked (no database, no application
 * context, nothing to start), and client API functions against a mocked
 * request helper, asserting the URL and method against the server routes.
 *
 * It can write test files only (`isTestFile`) — it may fix its own tests, but
 * not the code under test. A failure that points at the ported code is
 * reported as such, and the fix stage acts on it; the fix stage in turn cannot
 * touch the tests.
 *
 * A second mode re-runs the commands the first run reported, with no write
 * access at all, after a fix round.
 */

const WRITE_PROMPT = `You are the Clone Unit Test agent in an automated port pipeline.
A feature has just been ported into the target project: database scripts, server
code and client code. Write unit tests that prove its basic CRUD flow goes through,
run them, and report honestly.

What to test — the basic flow, not deep business rules:
- Server, for each ported controller: one test per endpoint (create, get by id,
  update, delete, search/list, and any combobox/lookup route), calling it through
  the framework's test client with the service mocked (Spring: MockMvc
  standaloneSetup or @WebMvcTest with Mockito mocks; NestJS: Test.createTestingModule
  with a mocked provider; Express: supertest). Assert the status code, and for a
  body, that the key fields come back. Add the obvious failure case per resource:
  get/update/delete of an id that does not exist returns the project's not-found
  behaviour, and create with a missing required field is rejected if the code
  validates it.
- Server, for each ported service: create saves and returns the saved record, get
  by id returns it or signals not-found, update changes the fields, delete removes
  it (or soft-deletes, if that is what the code does), search passes its filters on.
  Mock the repositories. Assert against what the code actually does.
- Client, for each ported API client module: mock the project's request helper
  and assert that each function calls the right HTTP method and URL (with the
  project's prefix) and passes the params/body through. The routes it must hit
  are listed below; a mismatch is a real bug, report it — do not change the
  expected URL to match the client.
- Do not start the application, a database, a browser or a dev server, and do not
  write integration tests. These must run in seconds with no infrastructure.

How:
- Follow the target's existing test conventions: folder (src/test/java mirroring
  the package, __tests__ or *.test.ts next to the code), frameworks already in its
  build files, naming. Use only test dependencies the project already declares.
- Write only test files. You cannot edit the code under test.
- Run exactly the new tests, scoped to the touched module/app (e.g. Maven
  \`-pl <module> -am test -Dtest='<Pattern>*Test' -Dsurefire.failIfNoSpecifiedTests=false\`,
  or \`npx jest <paths>\` from the client app folder). Put each command in
  "commands" exactly as a shell could re-run it from the folder you ran it in
  (prefix with \`cd <folder> &&\`).
- If a test fails because the TEST is wrong (wrong mock setup, wrong import),
  fix the test and re-run. If it fails because the PORTED CODE is wrong (wrong
  route, missing field, exception on a valid call), leave the test as it is and
  report the failure — that is the finding. Never delete, skip or loosen a test
  to make the run green.

Report ok=true only if every new test passes. List each failing test in
"failures" as "<test name>: <assertion or error message>" verbatim, and say in the
summary which failures point at the ported code.`;

const RERUN_PROMPT = `You are re-running unit tests in an automated port pipeline, after the
ported code was fixed. Run exactly the commands given, read the output, and report.
You cannot edit any file. Report ok=true only if every test passes; list each
failing test in "failures" as "<test name>: <assertion or error message>" verbatim.
Keep "commands" and "testFiles" as given.`;

const TEST_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    summary: { type: "string" },
    commands: { type: "array", items: { type: "string" } },
    testFiles: { type: "array", items: { type: "string" } },
    passed: { type: "number" },
    failed: { type: "number" },
    failures: { type: "array", items: { type: "string" } },
  },
  required: ["ok", "summary", "commands", "testFiles", "failures"],
};

export interface CloneTestRequest {
  clone: CloneInput;
  mapping: CloneMapping;
  conventions: TargetConventions | null;
  roots: ProjectRoot[];
  /** Server routes read from the ported code — what the client tests assert against. */
  serverApi: string[];
  runtimePorts?: number[];
  /** Re-run mode: the verdict of the first run, whose commands are run again. */
  rerun?: CloneTestVerdict;
}

export async function runCloneTests(request: CloneTestRequest): Promise<CloneTestVerdict> {
  const { clone, mapping, conventions, roots, serverApi, runtimePorts = [], rerun } = request;

  const options: Options = {
    systemPrompt: rerun ? RERUN_PROMPT : WRITE_PROMPT,
    allowedTools: ["Read", "Glob", "Grep", "Bash"],
    disallowedTools: [
      "Bash(git commit*)",
      "Bash(git push*)",
      "Bash(git branch*)",
      "Bash(git checkout*)",
      "Bash(git stash*)",
      ...networkExfilBashBlocklist,
    ],
    canUseTool: rerun ? denyAllWrites : guardTestWrites(clone.referencePaths),
    model: config.model,
    maxTurns: rerun ? config.maxTurns.cloneTestsRerun : config.maxTurns.cloneTests,
  };
  const secondary = secondaryRootDirs(roots);
  if (secondary.length) options.additionalDirectories = secondary;
  withIndexAccess(options, clone.projectIndexes);

  const prompt = rerun
    ? [
        "--- Commands to re-run ---",
        ...rerun.commands.map((command) => `- ${command}`),
        "",
        "--- Test files ---",
        ...rerun.testFiles.map((file) => `- ${file}`),
      ].join("\n")
    : [
        "--- What was ported ---",
        clone.what,
        ...targetRootsPromptSection(roots),
        ...indexPromptSection(clone.projectIndexes),
        "",
        "--- How the target project is organised ---",
        conventions?.summary ?? "(Not available — read the project's build files and existing tests.)",
        "",
        "--- Ported files, by layer ---",
        ...(["db", "be", "fe"] as const).flatMap((layer) => {
          const files = mapping.entries.filter((entry) => layerOf(entry) === layer);
          return files.length
            ? [`${layer.toUpperCase()}:`, ...files.map((entry) => `- ${location(entry.target, entry.root, roots)}`)]
            : [];
        }),
        "",
        "--- Server routes the ported code maps (read from it) ---",
        ...(serverApi.length ? serverApi : ["(none could be read — read the controllers yourself)"]),
        ...runtimePortsPromptSection(runtimePorts),
      ].join("\n");

  const result = await runStructuredQuery<CloneTestVerdict>(prompt, options, TEST_SCHEMA);
  if (!result.ok || !result.data) {
    // Fail-closed: no verdict is "not verified", never "passed".
    return {
      ok: false,
      summary: `Unit test stage produced no verdict: ${result.error ?? "unknown error"}`,
      commands: rerun?.commands ?? [],
      testFiles: rerun?.testFiles ?? [],
      failures: [],
    };
  }
  const verdict = result.data;
  // A run that reports ok with no tests written or run proves nothing.
  if (verdict.ok && (!verdict.commands?.length || !verdict.testFiles?.length)) {
    return { ...verdict, ok: false, summary: `${verdict.summary} (reported ok but no test files or commands — not counted as a pass)` };
  }
  return { ...verdict, failures: verdict.failures ?? [], commands: verdict.commands ?? [], testFiles: verdict.testFiles ?? [] };
}

function location(target: string, root: CloneMapping["entries"][number]["root"], roots: ProjectRoot[]): string {
  return isSplit(roots) ? path.resolve(rootPath(roots, root), target) : target;
}

/** Test files anywhere in the target; nothing else, and never a reference repo. */
export function guardTestWrites(referencePaths: string[]): CanUseTool {
  return async (toolName, input) => {
    if (toolName === "Write" || toolName === "Edit") {
      const filePath = String((input as { file_path?: string }).file_path ?? "");
      if (isInsideReference(filePath, referencePaths)) {
        return { behavior: "deny", message: "Reference repositories are read-only." };
      }
      if (!isTestFile(filePath)) {
        return {
          behavior: "deny",
          message:
            "The unit test stage writes test files only (src/test/..., __tests__/, *.test.*, *.spec.*). If the code under test is wrong, report the failing test — the fix stage acts on it.",
        };
      }
      return { behavior: "allow" };
    }
    return { behavior: "deny", message: `Tool "${toolName}" is not permitted in the unit test stage.` };
  };
}

const denyAllWrites: CanUseTool = async (toolName) => ({
  behavior: "deny",
  message: `Tool "${toolName}" is not permitted when re-running tests — this run only reports.`,
});
