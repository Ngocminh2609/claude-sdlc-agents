import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { E2eVerdict, ReviewVerdict, SpecInput, TaskItem } from "./types.js";

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface SpecsArchEntry {
  attempt: number;
  proposal: string;
}

interface ReviewEntry {
  attempt: number;
  review: ReviewVerdict;
}

interface CodingEntry {
  attempt: number;
  taskId: string;
  summary: string;
}

interface E2eEntry {
  attempt: number;
  verdict: E2eVerdict;
}

export class RunLogger {
  private readonly startedAt = new Date().toISOString();
  private finishedAt?: string;
  private readonly specsArch: SpecsArchEntry[] = [];
  private readonly reviews: ReviewEntry[] = [];
  private tasks: TaskItem[] = [];
  private readonly coding: CodingEntry[] = [];
  private readonly e2e: E2eEntry[] = [];
  private finalStatus = "in-progress";
  private finalMessage = "";
  private readonly runId: string;
  private readonly runDir: string;

  constructor(private readonly spec: SpecInput, specPath: string) {
    const timestamp = this.startedAt.replace(/[:.]/g, "-");
    const projectName = path.basename(spec.projectPath);
    const specSlug = path.basename(specPath).replace(/\.md$/i, "");
    this.runId = `${timestamp}-${projectName}-${specSlug}`;
    this.runDir = path.join(TOOL_ROOT, "runs", this.runId);
  }

  recordSpecsArch(attempt: number, proposal: string): void {
    this.specsArch.push({ attempt, proposal });
  }

  recordReview(attempt: number, review: ReviewVerdict): void {
    this.reviews.push({ attempt, review });
  }

  recordTaskBreakdown(tasks: TaskItem[]): void {
    this.tasks = tasks;
  }

  recordCoding(attempt: number, taskId: string, summary: string): void {
    this.coding.push({ attempt, taskId, summary });
  }

  recordE2e(attempt: number, verdict: E2eVerdict): void {
    this.e2e.push({ attempt, verdict });
  }

  finish(status: string, message: string): void {
    this.finalStatus = status;
    this.finalMessage = message;
    this.finishedAt = new Date().toISOString();
  }

  /** Never persists spec.dbInfo.value: it may be a connection string with a
   * real password, and a run log is not a safe place to keep credentials. */
  async write(): Promise<string> {
    await mkdir(this.runDir, { recursive: true });

    const data = {
      runId: this.runId,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt ?? new Date().toISOString(),
      spec: {
        projectPath: this.spec.projectPath,
        specMarkdown: this.spec.specMarkdown,
        dbInfoKind: this.spec.dbInfo?.kind ?? null,
      },
      specsArch: this.specsArch,
      reviews: this.reviews,
      tasks: this.tasks,
      coding: this.coding,
      e2e: this.e2e,
      finalStatus: this.finalStatus,
      finalMessage: this.finalMessage,
    };

    await writeFile(path.join(this.runDir, "log.json"), JSON.stringify(data, null, 2), "utf-8");
    await writeFile(path.join(this.runDir, "report.md"), this.toMarkdown(data), "utf-8");

    return this.runDir;
  }

  private toMarkdown(data: {
    runId: string;
    startedAt: string;
    finishedAt: string;
    spec: { projectPath: string; dbInfoKind: string | null };
    specsArch: SpecsArchEntry[];
    reviews: ReviewEntry[];
    tasks: TaskItem[];
    coding: CodingEntry[];
    e2e: E2eEntry[];
    finalStatus: string;
    finalMessage: string;
  }): string {
    const lines: string[] = [
      `# Run report — ${data.runId}`,
      "",
      `- Project: ${data.spec.projectPath}`,
      `- DB info: ${data.spec.dbInfoKind ?? "(none)"}`,
      `- Started: ${data.startedAt}`,
      `- Finished: ${data.finishedAt}`,
      `- Final status: **${data.finalStatus}**`,
      "",
      "## Specs & Arch / Orchestrator review",
      "",
    ];

    for (const entry of data.specsArch) {
      const review = data.reviews.find((r) => r.attempt === entry.attempt);
      lines.push(`### Attempt ${entry.attempt}`, "", "**Proposal:**", "", entry.proposal, "");
      if (review) {
        lines.push(
          `**Orchestrator decision:** ${review.review.decision}`,
          "",
          `**Feedback:** ${review.review.feedback}`,
          "",
        );
      }
    }

    if (data.tasks.length) {
      lines.push("## Tasks", "");
      for (const task of data.tasks) {
        lines.push(`- **${task.id}**: ${task.description}`);
      }
      lines.push("");
    }

    if (data.coding.length || data.e2e.length) {
      lines.push("## Coding / E2E loop", "");
      const maxAttempt = Math.max(0, ...data.coding.map((c) => c.attempt), ...data.e2e.map((e) => e.attempt));
      for (let attempt = 1; attempt <= maxAttempt; attempt++) {
        lines.push(`### Attempt ${attempt}`, "");
        for (const c of data.coding.filter((c) => c.attempt === attempt)) {
          lines.push(`- Coding \`${c.taskId}\`: ${c.summary}`);
        }
        const e2eEntry = data.e2e.find((e) => e.attempt === attempt);
        if (e2eEntry) {
          lines.push("", `**E2E verdict:** ${e2eEntry.verdict.verdict} — ${e2eEntry.verdict.summary}`);
          for (const ac of e2eEntry.verdict.acceptanceCriteria ?? []) {
            lines.push(`  - [${ac.covered ? "x" : " "}] ${ac.criterion} — ${ac.evidence}`);
          }
        }
        lines.push("");
      }
    }

    lines.push("## Final message", "", data.finalMessage, "");

    return lines.join("\n");
  }
}
