import type { DatabaseContext } from "./database-scripts.js";
import type { IndexRef } from "./project-index.js";
import type { MetadataStandards } from "./metadata-standards.js";
import type { SkillCatalog } from "./skills-catalog.js";
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
  /**
   * Set when the user gave a connection: the database the run's scripts are
   * applied to. Never carries credentials — this object reaches every prompt.
   */
  database?: DatabaseContext;
  /** Absolute paths to read-only source trees agents may copy patterns from. */
  referencePaths?: string[];
  /** Refreshed indexes of the target and reference repos — see `project-index.ts`. */
  projectIndexes?: IndexRef[];
  /** The target's opt-in metadata standards; null or absent when it has none. */
  metadataStandards?: MetadataStandards | null;
  /** Installed FIS skills available to this run; null or absent means none were found. */
  skillCatalog?: SkillCatalog | null;
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
  /** Installed FIS skills available to this run; null or absent means none were found. */
  skillCatalog?: SkillCatalog | null;
}

/** How the target project is organised, as read from the target itself. */
export interface TargetConventions {
  summary: string;
}

export interface CloneMappingEntry {
  /** Path in the reference repo, relative to its root. */
  source: string;
  /**
   * Path in the target project, relative to the target folder named by
   * `root`. Meaningless (and not checked) when `notPorted` is true — leave it
   * empty rather than inventing placeholder text; see `notPorted`.
   */
  target: string;
  /** Which target folder the file goes into when BE and FE are separate; else the project. */
  root?: RootRole;
  /** Port unit, e.g. "BE:category" — files sharing one are ported together. Meaningless when `notPorted` is true. */
  group: string;
  /** Renames and substitutions this file needs (package, imports, table names) — or, when `notPorted` is true, why. */
  changes: string;
  /** The mapping stage was not confident about this one. Never set together with `notPorted` — that is a decision, not a doubt. */
  uncertain?: boolean;
  /**
   * A mapping-time decision that this source file is not being ported at
   * all — a duplicate/read-only sibling variant, something superseded by an
   * existing target-side equivalent, or no target-side equivalent applies.
   * `changes` carries the reason. Distinct from a Clone Port `CloneDeviation`
   * (a per-group agent's own after-the-fact account of what it didn't write):
   * this is decided up front, before any group is even sent to Clone Port, so
   * such entries are skipped by the port loop and never billed a turn budget
   * for a file nobody intends to write. `checkCoverage` excludes them from
   * `missing` — an entry marked here is not a forgotten file, so it must not
   * read as one — but still surfaces them to the user, the same "a person
   * checks this claim" spirit as a `not-needed` deviation.
   */
  notPorted?: boolean;
  /**
   * Which layer the file belongs to. Groups are ported in layer order — database
   * scripts, then server, then client — so the client is written against a
   * server that already exists. Optional for mappings saved before it existed;
   * `layerOf` infers it then. Meaningless when `notPorted` is true.
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
  /** Mapping-time `notPorted` entries — excluded from `missing`, but still reported to the user (see `CloneMappingEntry.notPorted`). */
  excluded?: CloneMappingEntry[];
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
  /** The pipeline's own Playwright run (`src/e2e-check.ts`); absent only on a verdict from before it existed. */
  check?: E2eCheck;
}

/** An API call (or page error) the E2E guard saw go wrong while a test ran. */
export interface E2eApiProblem {
  test: string;
  kind: "http" | "network" | "page-error";
  method?: string;
  url: string;
  status?: number;
  message?: string;
}

/** What the pipeline's own run of the E2E tests found, read from Playwright's JSON results. */
export interface E2eCheck {
  /** False when the run could not happen or produced no results — see `error`. */
  ran: boolean;
  error?: string;
  total: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  failedTests: string[];
  /** Tests that did not import `test` from the guard, so their API calls went unchecked. */
  unguardedTests: string[];
  apiProblems: E2eApiProblem[];
  /** Where the traces, screenshots, videos and HTML report were written. */
  evidenceDir: string;
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
