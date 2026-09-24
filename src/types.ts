export interface DbInfo {
  kind: "connection" | "schema-file";
  value: string;
}

export interface SpecInput {
  specMarkdown: string;
  projectPath: string;
  dbInfo?: DbInfo;
  /** Absolute paths to read-only source trees agents may copy patterns from. */
  referencePaths?: string[];
}

/** One file in a reference repo that the work should copy from or follow. */
export interface ReferenceFile {
  path: string;
  role: string;
}

/**
 * The result of walking the reference repos once, before any design work, so
 * every later stage shares one explicit list of source files instead of each
 * session rediscovering the tree on its own turn budget.
 */
export interface ReferenceInventory {
  files: ReferenceFile[];
  /** What was deliberately excluded, and anything the scan was unsure about. */
  notes: string;
}

/**
 * One shared scan of the target project itself, produced once before Specs &
 * Arch and reused by every later stage in a feature-spec run — the same
 * "scan once, share the list" principle `ReferenceInventory` applies to
 * `--reference` repos, applied here to the project the spec is implemented
 * against, so specs-arch/task-breakdown/coding/e2e don't each rediscover it.
 */
export interface ProjectContext {
  /** How the project is organised — the same answer regardless of which spec runs against it. */
  conventions: string;
  /** Existing files/helpers this specific spec's work should read or reuse. */
  relevantFiles: ReferenceFile[];
  notes: string;
}

/**
 * Clone mode: porting an existing feature from a reference repo into a target
 * project, rather than building something new from a spec.
 *
 * The source code answers "what to build", so there is no design to propose or
 * approve. What has to be decided instead is where each file lands in a target
 * whose layout and package root differ — that decision is the mapping below,
 * and it is checkable afterwards in a way a design proposal never is.
 */
export interface CloneInput {
  /** What to clone, in the user's words: "Danh mục nghề nghiệp". */
  what: string;
  /** Absolute paths to the read-only reference repositories. */
  referencePaths: string[];
  projectPath: string;
}

/** How the target project is organised, as read from the target itself. */
export interface TargetConventions {
  summary: string;
}

export interface CloneMappingEntry {
  /** Path in the reference repo, relative to its root. */
  source: string;
  /** Path in the target project, relative to its root. */
  target: string;
  /** Port unit, e.g. "BE:category" — files sharing one are ported together. */
  group: string;
  /** Renames and substitutions this file needs (package, imports, table names). */
  changes: string;
  /** The mapping stage was not confident about this one. */
  uncertain?: boolean;
}

export interface CloneMapping {
  entries: CloneMappingEntry[];
  notes: string;
}

/** Result of checking the mapping against what is actually on disk. */
export interface CloneCoverage {
  present: string[];
  missing: string[];
}

export interface ReviewVerdict {
  decision: "approve" | "reject";
  feedback: string;
  concerns?: string[];
}

export interface TaskItem {
  id: string;
  description: string;
  targetFiles?: string[];
}

export interface TaskBreakdown {
  tasks: TaskItem[];
}

/**
 * A task the Coding stage already finished in this pass, passed to the tasks
 * that follow it. Each coding call is a fresh session with no memory of the
 * others, so without this the agent writing the front end has no idea what
 * the agent that wrote the API just named its endpoints.
 */
export interface CompletedTask {
  id: string;
  description: string;
  summary: string;
}

export interface AcceptanceCriterionCheck {
  criterion: string;
  covered: boolean;
  evidence: string;
}

export interface E2eVerdict {
  verdict: "pass" | "fail";
  summary: string;
  acceptanceCriteria?: AcceptanceCriterionCheck[];
  failedScenarios?: string[];
}

export interface E2eAttempt extends E2eVerdict {
  attempt: number;
}

export type EscalationStage = "specs-arch" | "e2e";

export interface EscalationDetails {
  stage: EscalationStage;
  lastProposal?: string | null;
  lastFeedback?: string;
  e2eHistory?: E2eAttempt[];
}
