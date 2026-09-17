import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { CloneBuildVerdict } from "./stages/clone-build.js";
import type {
  CloneCoverage,
  CloneInput,
  CloneMapping,
  E2eVerdict,
  ReferenceInventory,
  ReviewVerdict,
  SpecInput,
  TargetConventions,
  TaskItem,
} from "./types.js";

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Run folders are named the same way whichever pipeline produced them, so the
 * history listing (and anyone reading `runs/`) sorts them together by time.
 */
function buildRunId(startedAt: string, projectPath: string, label: string): string {
  const timestamp = startedAt.replace(/[:.]/g, "-");
  return `${timestamp}-${path.basename(projectPath)}-${slugify(label)}`;
}

function runDirFor(runId: string): string {
  return path.join(TOOL_ROOT, "runs", runId);
}

/** A run id becomes a folder name, so it may only hold path-safe characters. */
function slugify(label: string): string {
  const slug = label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "run";
}

async function persist(runDir: string, data: unknown, markdown: string): Promise<string> {
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "log.json"), JSON.stringify(data, null, 2), "utf-8");
  await writeFile(path.join(runDir, "report.md"), markdown, "utf-8");
  return runDir;
}

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
  private referenceInventory: ReferenceInventory | null = null;
  private readonly coding: CodingEntry[] = [];
  private readonly e2e: E2eEntry[] = [];
  private finalStatus = "in-progress";
  private finalMessage = "";
  private readonly runId: string;
  private readonly runDir: string;

  constructor(private readonly spec: SpecInput, specPath: string) {
    this.runId = buildRunId(this.startedAt, spec.projectPath, path.basename(specPath).replace(/\.md$/i, ""));
    this.runDir = runDirFor(this.runId);
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

  /** null when no reference repo was given, or when the scan failed. */
  recordReferenceInventory(inventory: ReferenceInventory | null): void {
    this.referenceInventory = inventory;
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
    const data = {
      runId: this.runId,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt ?? new Date().toISOString(),
      spec: {
        projectPath: this.spec.projectPath,
        specMarkdown: this.spec.specMarkdown,
        dbInfoKind: this.spec.dbInfo?.kind ?? null,
        referencePaths: this.spec.referencePaths ?? [],
      },
      referenceInventory: this.referenceInventory,
      specsArch: this.specsArch,
      reviews: this.reviews,
      tasks: this.tasks,
      coding: this.coding,
      e2e: this.e2e,
      finalStatus: this.finalStatus,
      finalMessage: this.finalMessage,
    };

    return persist(this.runDir, data, this.toMarkdown(data));
  }

  private toMarkdown(data: {
    runId: string;
    startedAt: string;
    finishedAt: string;
    spec: { projectPath: string; dbInfoKind: string | null; referencePaths: string[] };
    referenceInventory: ReferenceInventory | null;
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
    ];

    // Written before the design section on purpose: this is the checklist a
    // reader diffs the delivered files against.
    if (data.spec.referencePaths.length) {
      lines.push("## Reference repositories", "");
      for (const reference of data.spec.referencePaths) lines.push(`- ${reference}`);
      lines.push("");

      if (!data.referenceInventory) {
        lines.push(
          "_The inventory stage produced no file list for this run — the later stages",
          "worked from their own exploration of the references instead._",
          "",
        );
      } else {
        lines.push(`### Inventoried files (${data.referenceInventory.files.length})`, "");
        for (const file of data.referenceInventory.files) {
          lines.push(`- \`${file.path}\` — ${file.role}`);
        }
        if (data.referenceInventory.notes.trim()) {
          lines.push("", `**Inventory notes:** ${data.referenceInventory.notes.trim()}`);
        }
        lines.push("");
      }
    }

    lines.push("## Specs & Arch / Orchestrator review", "");

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

/**
 * Run log for a clone run.
 *
 * A separate class rather than more optional fields on RunLogger: the two
 * pipelines record different things, and a single logger where half the
 * methods are dead on any given run makes it unclear which report a reader is
 * looking at. They share the parts that genuinely are the same — the run id
 * shape and how the two files get written — so `runs/` stays one uniform
 * history.
 *
 * The mapping table is the point of this report. It is what a reader diffs
 * against `git diff --stat` to see whether the port actually landed.
 */
export class CloneRunLogger {
  private readonly startedAt = new Date().toISOString();
  private finishedAt?: string;
  private referenceInventory: ReferenceInventory | null = null;
  private conventions: TargetConventions | null = null;
  private mapping: CloneMapping | null = null;
  private coverage: CloneCoverage | null = null;
  private build: CloneBuildVerdict | null = null;
  private readonly ports: { group: string; summary: string }[] = [];
  private finalStatus = "in-progress";
  private finalMessage = "";
  private readonly runId: string;
  private readonly runDir: string;

  constructor(private readonly clone: CloneInput) {
    this.runId = buildRunId(this.startedAt, clone.projectPath, `clone-${clone.what}`);
    this.runDir = runDirFor(this.runId);
  }

  recordReferenceInventory(inventory: ReferenceInventory | null): void {
    this.referenceInventory = inventory;
  }

  recordTargetConventions(conventions: TargetConventions | null): void {
    this.conventions = conventions;
  }

  recordCloneMapping(mapping: CloneMapping | null): void {
    this.mapping = mapping;
  }

  recordClonePort(group: string, summary: string): void {
    this.ports.push({ group, summary });
  }

  recordCloneCoverage(coverage: CloneCoverage): void {
    this.coverage = coverage;
  }

  recordCloneBuild(build: CloneBuildVerdict): void {
    this.build = build;
  }

  finish(status: string, message: string): void {
    this.finalStatus = status;
    this.finalMessage = message;
    this.finishedAt = new Date().toISOString();
  }

  async write(): Promise<string> {
    const data = {
      runId: this.runId,
      mode: "clone",
      startedAt: this.startedAt,
      finishedAt: this.finishedAt ?? new Date().toISOString(),
      spec: {
        // Same shape as a feature run's log so the history listing can read
        // both without knowing which pipeline wrote the file.
        projectPath: this.clone.projectPath,
        specMarkdown: this.clone.what,
        dbInfoKind: null,
        referencePaths: this.clone.referencePaths,
      },
      what: this.clone.what,
      referenceInventory: this.referenceInventory,
      targetConventions: this.conventions,
      mapping: this.mapping,
      ports: this.ports,
      coverage: this.coverage,
      build: this.build,
      finalStatus: this.finalStatus,
      finalMessage: this.finalMessage,
    };

    return persist(this.runDir, data, this.toMarkdown());
  }

  private toMarkdown(): string {
    const lines: string[] = [
      `# Clone report — ${this.runId}`,
      "",
      `- Cloning: **${this.clone.what}**`,
      `- Target project: ${this.clone.projectPath}`,
      ...this.clone.referencePaths.map((reference) => `- Reference: ${reference}`),
      `- Started: ${this.startedAt}`,
      `- Finished: ${this.finishedAt ?? "(unfinished)"}`,
      `- Final status: **${this.finalStatus}**`,
      "",
    ];

    if (this.coverage) {
      const total = this.coverage.present.length + this.coverage.missing.length;
      lines.push(
        "## Coverage",
        "",
        `${this.coverage.present.length} of ${total} mapped file(s) are present in the target.`,
        "",
      );
      if (this.coverage.missing.length) {
        lines.push("**Missing:**", "");
        for (const missing of this.coverage.missing) lines.push(`- \`${missing}\``);
        lines.push("");
      }
    }

    if (this.build) {
      lines.push(
        "## Build check",
        "",
        `**Verdict:** ${this.build.ok ? "pass" : "fail"} — ${this.build.summary}`,
        "",
      );
      if (this.build.command) lines.push(`Command: \`${this.build.command}\``, "");
      for (const error of this.build.errors ?? []) lines.push(`- ${error}`);
      if (this.build.errors?.length) lines.push("");
    }

    if (this.mapping) {
      lines.push("## File mapping", "");
      for (const entry of this.mapping.entries) {
        const present = this.coverage?.present.includes(entry.target);
        const mark = this.coverage ? (present ? "x" : " ") : " ";
        lines.push(
          `- [${mark}] **${entry.group}** \`${entry.source}\` → \`${entry.target}\`${entry.uncertain ? " _(uncertain)_" : ""}`,
          `  - changes: ${entry.changes}`,
        );
      }
      if (this.mapping.notes.trim()) lines.push("", `**Mapping notes:** ${this.mapping.notes.trim()}`);
      lines.push("");
    }

    if (this.referenceInventory) {
      lines.push(`## Source files found (${this.referenceInventory.files.length})`, "");
      for (const file of this.referenceInventory.files) {
        lines.push(`- \`${file.path}\` — ${file.role}`);
      }
      if (this.referenceInventory.notes.trim()) {
        lines.push("", `**Inventory notes:** ${this.referenceInventory.notes.trim()}`);
      }
      lines.push("");
    }

    if (this.ports.length) {
      lines.push("## Port log", "");
      for (const port of this.ports) lines.push(`### ${port.group}`, "", port.summary, "");
    }

    if (this.conventions) {
      lines.push("## Target conventions as read", "", this.conventions.summary, "");
    }

    lines.push("## Final message", "", this.finalMessage, "");

    return lines.join("\n");
  }
}
