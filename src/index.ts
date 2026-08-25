import { readFile } from "node:fs/promises";
import process from "node:process";
import { runPipeline } from "./pipeline.js";
import { getGithubAdapter } from "./github/index.js";
import type { IssueTask } from "./types.js";

function parseArgs(argv: string[]): { issueFile?: string; dryRun: boolean } {
  let issueFile: string | undefined;
  let dryRun = process.env.DRY_RUN === "true";

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--issue-file") {
      issueFile = argv[i + 1];
      i++;
    } else if (argv[i] === "--dry-run") {
      dryRun = true;
    }
  }

  return { issueFile, dryRun };
}

async function loadIssue(issueFile?: string): Promise<IssueTask> {
  if (issueFile) {
    const raw = await readFile(issueFile, "utf-8");
    return JSON.parse(raw) as IssueTask;
  }

  const number = Number(process.env.ISSUE_NUMBER);
  const title = process.env.ISSUE_TITLE ?? "";
  const body = process.env.ISSUE_BODY ?? "";
  const repoFullName = process.env.REPO_FULL_NAME ?? "";

  if (!number || !title) {
    throw new Error(
      "Missing issue input: pass --issue-file <path> or set ISSUE_NUMBER/ISSUE_TITLE/ISSUE_BODY/REPO_FULL_NAME.",
    );
  }

  return { number, title, body, repoFullName };
}

async function main(): Promise<void> {
  const { issueFile, dryRun } = parseArgs(process.argv.slice(2));
  const issue = await loadIssue(issueFile);

  const github = getGithubAdapter({
    dryRun,
    repoFullName: issue.repoFullName,
    token: process.env.GITHUB_TOKEN,
  });

  const result = await runPipeline({
    issue,
    repoDir: process.cwd(),
    github,
    push: !dryRun,
  });

  console.log(`Pipeline finished with status: ${result.status}`);
  if (result.branchName) {
    console.log(`Branch: ${result.branchName}`);
  }

  if (result.status !== "pushed") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Pipeline crashed:", error);
  process.exitCode = 1;
});
