export interface DbInfo {
  kind: "connection" | "schema-file";
  value: string;
}

export interface SpecInput {
  specMarkdown: string;
  projectPath: string;
  dbInfo?: DbInfo;
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
