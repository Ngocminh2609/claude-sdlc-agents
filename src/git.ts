import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";

const run = promisify(execFile);

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

export function branchNameFor(issueNumber: number, title: string): string {
  return `${config.branchPrefix}-${issueNumber}-${slugify(title)}`;
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await run("git", args, { cwd });
  return stdout.trim();
}

export interface CommitAndPushOptions {
  cwd: string;
  branchName: string;
  commitMessage: string;
  push: boolean;
}

export async function createBranch(cwd: string, branchName: string): Promise<void> {
  await git(["checkout", "-b", branchName], cwd);
}

export async function commitAndPush(opts: CommitAndPushOptions): Promise<void> {
  const { cwd, branchName, commitMessage, push } = opts;
  await git(["add", "-A"], cwd);

  const status = await git(["status", "--porcelain"], cwd);
  if (!status) {
    return;
  }

  await git(["commit", "-m", commitMessage], cwd);

  if (push) {
    await git(["push", "-u", "origin", branchName], cwd);
  }
}
