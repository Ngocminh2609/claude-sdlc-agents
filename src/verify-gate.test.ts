import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  describeGateFailure,
  refusalOf,
  runShellCommand,
  runVerifyGate,
  usableVerifyCommands,
  type CommandRunner,
} from "./verify-gate.js";

describe("refusalOf", () => {
  it.each([
    "npm run lint",
    "npm run lint:ci",
    "./mvnw -q -B compile",
    "mvn clean compile",
    "gradlew.bat check",
    "npx tsc --noEmit",
    "pnpm run typecheck",
    "dotnet build --no-restore",
  ])("lets a check run: %s", (command) => {
    expect(refusalOf(command)).toBeNull();
  });

  it.each([
    ["npm install", "changes dependencies"],
    ["npm ci", "changes dependencies"],
    ["yarn add lodash", "changes dependencies"],
    ["mvn deploy", "deploys"],
    ["mvn deploy:deploy-file", "deploys"],
    ["npm run build && rm -rf dist", "chains"],
    ["npm run lint > out.txt", "chains"],
    ["npm run lint -- --fix", "rewrites source"],
    ["mvn spotless:apply", "rewrites source"],
    ["bash -c 'make'", "not a known build tool"],
    ["node scripts/release.js", "not a known build tool"],
    ["", "empty"],
  ])("refuses %s", (command, reason) => {
    expect(refusalOf(command)).toContain(reason);
  });
});

describe("usableVerifyCommands", () => {
  const roots = [
    { role: "be" as const, path: path.resolve("/work/be") },
    { role: "fe" as const, path: path.resolve("/work/fe") },
  ];

  it("keeps commands that run in a target folder and refuses the rest with a reason", () => {
    const { usable, refused } = usableVerifyCommands(
      [
        { folder: path.resolve("/work/be/"), command: " ./mvnw -q compile " },
        { folder: path.resolve("/elsewhere"), command: "npm run lint" },
        { folder: path.resolve("/work/fe"), command: "npm publish" },
      ],
      roots,
    );

    expect(usable).toEqual([{ folder: roots[0].path, command: "./mvnw -q compile" }]);
    expect(refused.map((entry) => entry.reason)).toEqual([
      "does not run in a target folder",
      "changes dependencies instead of checking the code",
    ]);
  });

  it("has nothing to run when the scan gave no command", () => {
    expect(usableVerifyCommands(undefined, roots)).toEqual({ usable: [], refused: [] });
  });
});

describe("runVerifyGate", () => {
  const commands = [
    { folder: "/p", command: "npm run typecheck" },
    { folder: "/p", command: "npm run lint" },
  ];

  it("passes when every command exits 0", async () => {
    const run: CommandRunner = async () => ({ exitCode: 0, output: "", timedOut: false });
    expect(await runVerifyGate(commands, { timeoutMs: 1000, tailLines: 5, run })).toEqual({ ok: true, ran: 2 });
  });

  it("stops at the first failure and keeps the last lines of its output, blank lines dropped", async () => {
    const calls: string[] = [];
    const run: CommandRunner = async (command) => {
      calls.push(command);
      return { exitCode: 2, output: "line 1\n\nline 2\nline 3\n", timedOut: false };
    };

    const result = await runVerifyGate(commands, { timeoutMs: 1000, tailLines: 2, run });

    expect(calls).toEqual(["npm run typecheck"]);
    expect(result).toMatchObject({ ok: false, ran: 1, failure: { command: "npm run typecheck", exitCode: 2, tail: "line 2\nline 3" } });
    expect(describeGateFailure(result.failure!)).toBe(
      "`npm run typecheck` in /p exited with code 2. Last lines of its output:\nline 2\nline 3",
    );
  });

  it("counts a timeout as a failure", async () => {
    const run: CommandRunner = async () => ({ exitCode: 0, output: "", timedOut: true });
    const result = await runVerifyGate(commands.slice(0, 1), { timeoutMs: 1, tailLines: 5, run });
    expect(result.ok).toBe(false);
    expect(describeGateFailure(result.failure!)).toContain("timed out");
  });
});

describe("runShellCommand", () => {
  it("runs a real command and reports its exit code and output", async () => {
    const pass = await runShellCommand(`"${process.execPath}" -e "console.log('built')"`, process.cwd(), 30_000);
    expect(pass).toMatchObject({ exitCode: 0, timedOut: false });
    expect(pass.output).toContain("built");

    const fail = await runShellCommand(`"${process.execPath}" -e "process.exit(3)"`, process.cwd(), 30_000);
    expect(fail.exitCode).toBe(3);
  });

  it("does not hand the pipeline's credentials to the build", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-never-leaks";
    try {
      const result = await runShellCommand(
        `"${process.execPath}" -e "console.log(process.env.ANTHROPIC_API_KEY ?? 'unset')"`,
        process.cwd(),
        30_000,
      );
      expect(result.output).toContain("unset");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});
