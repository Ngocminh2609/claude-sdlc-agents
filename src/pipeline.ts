import { config } from "./config.js";
import { branchNameFor, createBranch, commitAndPush } from "./git.js";
import { runSpecsArch } from "./stages/specs-arch.js";
import { reviewSpecs } from "./stages/orchestrator-review.js";
import { runCoding } from "./stages/coding.js";
import { runQa } from "./stages/qa.js";
import type { GithubAdapter } from "./github/index.js";
import type { IssueTask, QaAttempt } from "./types.js";

export interface PipelineResult {
  status: "pushed" | "escalated-specs" | "escalated-qa";
  branchName?: string;
}

export interface PipelineOptions {
  issue: IssueTask;
  repoDir: string;
  github: GithubAdapter;
  push: boolean;
}

export async function runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const { issue, repoDir, github, push } = opts;

  // --- Loop 1: Specs & Arch <-> Orchestrator review ---
  let spec: string | null = null;
  let feedback: string | undefined;
  let approved = false;

  for (let attempt = 1; attempt <= config.maxSpecAttempts; attempt++) {
    spec = await runSpecsArch(issue, spec, feedback);
    const review = await reviewSpecs(issue, spec);
    if (review.decision === "approve") {
      approved = true;
      break;
    }
    feedback = review.feedback;
  }

  if (!approved) {
    await github.postComment(
      issue.number,
      [
        "**AI pipeline stopped: design proposal not approved after " +
          `${config.maxSpecAttempts} attempts.**`,
        "",
        "Last proposal:",
        spec ?? "(none)",
        "",
        "Last reviewer feedback:",
        feedback ?? "(none)",
        "",
        "A human needs to clarify the issue or take over from here.",
      ].join("\n"),
    );
    return { status: "escalated-specs" };
  }

  // --- Loop 2: Coding & Unit Test <-> QA/Tester ---
  const branchName = branchNameFor(issue.number, issue.title);
  await createBranch(repoDir, branchName);

  let qaFeedback: string | undefined;
  let passed = false;
  const qaHistory: QaAttempt[] = [];

  for (let attempt = 1; attempt <= config.maxCodingAttempts; attempt++) {
    await runCoding(issue, spec as string, qaFeedback);
    const qa = await runQa(issue, spec as string);
    qaHistory.push({ ...qa, attempt });
    if (qa.verdict === "pass") {
      passed = true;
      break;
    }
    qaFeedback = `${qa.summary}\nFailed checks: ${(qa.failedChecks ?? []).join(", ")}`;
  }

  const commitMessage = passed
    ? `feat: implement #${issue.number} ${issue.title}`
    : `wip: partial implementation of #${issue.number} ${issue.title} (QA did not pass)`;

  await commitAndPush({ cwd: repoDir, branchName, commitMessage, push });

  if (!passed) {
    await github.postComment(
      issue.number,
      [
        `**AI pipeline stopped: QA did not pass after ${config.maxCodingAttempts} attempts.**`,
        "",
        `A work-in-progress branch \`${branchName}\` was pushed for inspection.`,
        "",
        "QA history:",
        ...qaHistory.map(
          (q) => `- attempt ${q.attempt}: ${q.verdict} — ${q.summary}`,
        ),
        "",
        "A human needs to review and finish this from here.",
      ].join("\n"),
    );
    return { status: "escalated-qa", branchName };
  }

  await github.postComment(
    issue.number,
    [
      "**AI pipeline finished: QA passed.**",
      "",
      `Branch \`${branchName}\` was pushed. Open a pull request when you're ready to review it.`,
    ].join("\n"),
  );

  return { status: "pushed", branchName };
}
