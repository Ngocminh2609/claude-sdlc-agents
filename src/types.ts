export interface IssueTask {
  number: number;
  title: string;
  body: string;
  repoFullName: string;
}

export interface ReviewVerdict {
  decision: "approve" | "reject";
  feedback: string;
  concerns?: string[];
}

export interface QaVerdict {
  verdict: "pass" | "fail";
  summary: string;
  failedChecks?: string[];
}

export interface QaAttempt extends QaVerdict {
  attempt: number;
}

export type EscalationStage = "specs-arch" | "qa";

export interface EscalationDetails {
  stage: EscalationStage;
  lastSpec?: string | null;
  lastFeedback?: string;
  qaHistory?: QaAttempt[];
  pushWip?: boolean;
}
