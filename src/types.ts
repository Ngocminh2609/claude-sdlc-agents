import type { IndexRef } from "./project-index.js";
import type { MetadataStandards } from "./metadata-standards.js";
import type { ProjectRoot, RootRole } from "./target-roots.js";

export interface DbInfo {
  kind: "connection" | "schema-file";
  value: string;
}

export interface SpecInput {
  specMarkdown: string;
  /** The working directory: the first of `targetRoots`. */
  projectPath: string;
  /** Separate BE/FE folders, or one "app" folder. Absent means just `projectPath`. */
  targetRoots?: ProjectRoot[];
  dbInfo?: DbInfo;
  /** Absolute paths to read-only source trees agents may copy patterns from. */
  referencePaths?: string[];
  /** Refreshed indexes of the target and reference repos — see `project-index.ts`. */
  projectIndexes?: IndexRef[];
  /** The target's opt-in metadata standards; null or absent when it has none. */
  metadataStandards?: MetadataStandards | null;
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
  /** Clone mode: the feature a loose keyword was resolved to. */
  resolvedFeature?: string;
  /** Clone mode: other features the keyword also matched, not ported. */
  alternatives?: string[];
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
  /** What to clone: a keyword, Vietnamese or English — "nghề nghiệp", "occupation". */
  what: string;
  /** Absolute paths to the read-only reference repositories (all of them). */
  referencePaths: string[];
  /** The same references with their role, when BE and FE sources were given separately. */
  referenceRoots?: ProjectRoot[];
  /** The working directory: the first of `targetRoots`. */
  projectPath: string;
  /** Separate BE/FE target folders, or one "app" folder. Absent means just `projectPath`. */
  targetRoots?: ProjectRoot[];
  /** Refreshed indexes of the target and reference repos — see `project-index.ts`. */
  projectIndexes?: IndexRef[];
  /** The target's opt-in metadata standards; null or absent when it has none. */
  metadataStandards?: MetadataStandards | null;
}

/** How the target project is organised, as read from the target itself. */
export interface TargetConventions {
  summary: string;
}

export interface CloneMappingEntry {
  /** Path in the reference repo, relative to its root. */
  source: string;
  /** Path in the target project, relative to the target folder named by `root`. */
  target: string;
  /** Which target folder the file goes into when BE and FE are separate; else the project. */
  root?: RootRole;
  /** Port unit, e.g. "BE:category" — files sharing one are ported together. */
  group: string;
  /** Renames and substitutions this file needs (package, imports, table names). */
  changes: string;
  /** The mapping stage was not confident about this one. */
  uncertain?: boolean;
  /**
   * Which layer the file belongs to. Groups are ported in layer order — database
   * scripts, then server, then client — so the client is written against a
   * server that already exists. Optional for mappings saved before it existed;
   * `layerOf` infers it then.
   */
  layer?: CloneLayer;
}

export type CloneLayer = "db" | "be" | "fe";

export interface CloneMapping {
  entries: CloneMappingEntry[];
  notes: string;
}

/**
 * A mapping entry the port agent deliberately did not write as listed, and
 * said so. Declared rather than silent, so coverage can tell a considered
 * choice from a forgotten file:
 * - merged: its code lives in another file the agent wrote (`coveredBy`, in
 *   the same target folder) — counted as covered only if that file exists.
 * - not-needed: the agent judged it unnecessary — still counted missing, with
 *   the reason shown, because "not needed" is the claim a person should check.
 *
 * There is deliberately no "generated" kind. A client file the target normally
 * generates (an OpenAPI client) was once accepted as "to be generated later";
 * the ported pages then imported files that did not exist and the feature could
 * not run. Such files are written by hand in the generator's shape instead.
 */
export interface CloneDeviation {
  target: string;
  kind: "merged" | "not-needed";
  coveredBy?: string;
  reason: string;
}

/** What one port group reported back. */
export interface ClonePortResult {
  summary: string;
  deviations: CloneDeviation[];
}

/**
 * The unit-test stage's verdict: tests it wrote for the ported feature's basic
 * CRUD flow, the commands that run them, and what happened.
 */
export interface CloneTestVerdict {
  ok: boolean;
  summary: string;
  /** Commands that run exactly the new tests, one per folder, re-runnable as-is. */
  commands: string[];
  testFiles: string[];
  passed?: number;
  failed?: number;
  /** Each failing test with its assertion or error message, verbatim. */
  failures: string[];
}

/** Result of checking the mapping against what is actually on disk. */
export interface CloneCoverage {
  present: string[];
  missing: string[];
  /** Declared merges whose `coveredBy` file is on disk. */
  merged?: CloneDeviation[];
}

/** An import in a ported file that resolves to nothing on disk. */
export interface UnresolvedImport {
  file: string;
  specifier: string;
}

/** A client-side API call no server-side controller maps. */
export interface UnmatchedApiCall {
  file: string;
  method: string | null;
  url: string;
}

/**
 * Whether the ported client and server are actually connected: every local
 * import resolves, and every API path the client calls is mapped by some
 * controller in the server folder. Deterministic — see `clone-wiring.ts`.
 */
export interface CloneWiring {
  unresolvedImports: UnresolvedImport[];
  unmatchedCalls: UnmatchedApiCall[];
  /** How many client calls were checked, and how many server endpoints were known. */
  callsChecked: number;
  endpointsKnown: number;
}

export interface ReviewVerdict {
  decision: "approve" | "reject";
  feedback: string;
  concerns?: string[];
  /**
   * On an approval: small, exact fixes the reviewer requires, which become part
   * of the approved design instead of costing a full redesign round.
   */
  amendments?: string[];
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
