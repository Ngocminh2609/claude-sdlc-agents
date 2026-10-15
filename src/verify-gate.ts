import { spawn } from "node:child_process";
import path from "node:path";
import { killTree } from "./kill-tree.js";
import type { ProjectRoot } from "./target-roots.js";

/**
 * The build check the pipeline runs itself after each feature Coding task:
 * the project's own compile / type-check / lint commands, judged by their exit
 * code — no model involved. Until this existed, "the task builds" was the
 * Coding agent's own word, and a task that broke the build was found only by
 * E2E, after every later task had been written on top of it.
 *
 * Same stance as `checkCoverage` and the database script runner: which
 * commands run, where, and whether one is allowed to, is decided by plain code
 * here. The commands come from the Project Context scan (read from the
 * project's CI config and build files), so before one runs it has to pass
 * `refusalOf`: a known build tool, check-only (no install/deploy/fix/write),
 * no chaining or redirection, inside a target folder. The residual trust is
 * the project's own scripts (`npm run lint` runs whatever package.json says) —
 * the same code the Coding stage already builds with Bash.
 *
 * A failure is reported, not retried (CLAUDE.md: nothing after the design
 * review is retried): the run stops, and the next run resumes that task's own
 * session with the failure in front of it.
 */

/** Opens the prompt block that tells a Coding session the build check failed after it. */
export const BUILD_CHECK_FAILED_HEADER = "--- The pipeline's build check failed after this task ---";

export interface VerifyCommand {
  /** Absolute path of the target folder the command runs in. */
  folder: string;
  command: string;
}

export interface GateFailure {
  command: string;
  folder: string;
  exitCode: number | null;
  timedOut: boolean;
  /** The last lines of the command's output, verbatim. */
  tail: string;
}

export interface GateResult {
  ok: boolean;
  ran: number;
  failure?: GateFailure;
}

export interface CommandOutcome {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

export type CommandRunner = (command: string, cwd: string, timeoutMs: number) => Promise<CommandOutcome>;

/** First words of the build tools a check may start with. */
const BUILD_TOOLS = new Set([
  "mvn",
  "mvnw",
  "mvnw.cmd",
  "gradle",
  "gradlew",
  "gradlew.bat",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "tsc",
  "eslint",
  "dotnet",
  "go",
  "cargo",
  "make",
]);

/** Words (anywhere, as a whole word or a Maven `plugin:goal` part) that ship, delete or call out. */
const FORBIDDEN_WORDS = new Set([
  "deploy",
  "publish",
  "push",
  "release",
  "git",
  "docker",
  "kubectl",
  "curl",
  "wget",
  "rm",
  "del",
  "rmdir",
  "rd",
]);

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn"]);

/** Package-manager subcommands that change dependencies or the account rather than check code. */
const PACKAGE_CHANGES = new Set([
  "install",
  "i",
  "ci",
  "add",
  "remove",
  "rm",
  "uninstall",
  "upgrade",
  "update",
  "up",
  "publish",
  "login",
  "logout",
  "link",
  "unlink",
  "dlx",
]);

/** Flags or goals that rewrite source files instead of checking them. */
const WRITES_SOURCE = /(--fix\b|--write\b|:apply\b)/i;

/** Why a command may not run as a check, or null when it may. */
export function refusalOf(command: string): string | null {
  const text = command.trim();
  if (!text) return "empty command";
  if (/[;&|<>`$\r\n]/.test(text)) return "chains, pipes or redirects commands";
  const words = text.split(/\s+/);
  const tool = path.basename(words[0]).toLowerCase();
  if (!BUILD_TOOLS.has(tool)) return `"${tool}" is not a known build tool`;
  if (PACKAGE_MANAGERS.has(tool) && PACKAGE_CHANGES.has((words[1] ?? "").toLowerCase())) {
    return "changes dependencies instead of checking the code";
  }
  if (text.toLowerCase().split(/[\s:]+/).some((word) => FORBIDDEN_WORDS.has(word))) {
    return "deploys, deletes or calls out of the project";
  }
  if (WRITES_SOURCE.test(text)) return "rewrites source files instead of checking them";
  return null;
}

/**
 * The commands that may run, in order, and why the others may not. A folder
 * that is not one of the target folders is refused: the check runs in the
 * project being built, never elsewhere.
 */
export function usableVerifyCommands(
  commands: VerifyCommand[] | undefined,
  roots: ProjectRoot[],
): { usable: VerifyCommand[]; refused: { command: string; reason: string }[] } {
  const usable: VerifyCommand[] = [];
  const refused: { command: string; reason: string }[] = [];
  for (const entry of commands ?? []) {
    const root = roots.find((candidate) => sameFolder(candidate.path, entry.folder));
    const reason = root ? refusalOf(entry.command) : "does not run in a target folder";
    if (reason) refused.push({ command: entry.command, reason });
    else usable.push({ folder: (root as ProjectRoot).path, command: entry.command.trim() });
  }
  return { usable, refused };
}

/** Runs the commands in order and stops at the first failure. */
export async function runVerifyGate(
  commands: VerifyCommand[],
  opts: { timeoutMs: number; tailLines: number; run?: CommandRunner },
): Promise<GateResult> {
  const run = opts.run ?? runShellCommand;
  let ran = 0;
  for (const { command, folder } of commands) {
    const outcome = await run(command, folder, opts.timeoutMs);
    ran++;
    if (outcome.exitCode !== 0 || outcome.timedOut) {
      return {
        ok: false,
        ran,
        failure: {
          command,
          folder,
          exitCode: outcome.exitCode,
          timedOut: outcome.timedOut,
          tail: lastLines(outcome.output, opts.tailLines),
        },
      };
    }
  }
  return { ok: true, ran };
}

/** One line per failure fact, then the output — what the user and the resumed Coding session read. */
export function describeGateFailure(failure: GateFailure): string {
  const how = failure.timedOut ? "timed out" : `exited with code ${failure.exitCode ?? "unknown"}`;
  return [`\`${failure.command}\` in ${failure.folder} ${how}. Last lines of its output:`, failure.tail].join("\n");
}

/** Output the runner keeps per command; the tail is all anyone reads. */
const MAX_KEPT_CHARS = 200_000;

/** Credentials the pipeline holds that no build command needs. */
const STRIPPED_ENV = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];

export const runShellCommand: CommandRunner = (command, cwd, timeoutMs) =>
  new Promise((resolve) => {
    const env = { ...process.env };
    for (const name of STRIPPED_ENV) delete env[name];
    // A shell, because Windows build tools are .cmd/.bat files; `refusalOf`
    // has already ruled out anything the shell would chain or redirect.
    const child = spawn(command, { cwd, env, shell: true, windowsHide: true, detached: process.platform !== "win32" });
    let output = "";
    let timedOut = false;
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString("utf-8")).slice(-MAX_KEPT_CHARS);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, output: `${output}\n${error.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, output, timedOut });
    });
  });

function lastLines(text: string, count: number): string {
  // Blank lines dropped: the tail is carried into a resumed prompt as one block.
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  return lines.slice(-count).join("\n");
}

function sameFolder(a: string, b: string): boolean {
  const norm = (p: string) => {
    const resolved = path.resolve(p).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}
