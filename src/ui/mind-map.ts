import type { RunState, StepState } from "./runner.js";
import { STAGE_IDS_BY_MODE, type StageId } from "./stages.js";

/**
 * The run as a tree the UI draws as a mind map: the run at the root, its
 * stages around it, and under a stage the units it works through — Coding's
 * tasks (each with its build check), Clone Port's groups, a stage's repeated
 * steps (build/test/fix rounds). Computed here, not in the browser, so the
 * percentages have tests and the front end only draws.
 *
 * What a percentage means, stated because a number on screen reads as fact:
 * - A finished step is 100. A step not started is 0.
 * - A running agent step shows turns used of its stage's turn cap (`estimate`
 *   is true), capped at 95: an agent can finish at any turn, so this is how
 *   much of its allowance is spent, not how much of the work is done.
 * - A running plain-code step (the build check, coverage, wiring) has no
 *   measure at all: `percent` is null and the UI shows it as running.
 * - A stage or the run is the mean of its parts, counting an unmeasured
 *   running part as half done.
 *
 * Labels are ids or data (a task's own first line), never UI wording: what a
 * stage is called on screen lives in `public/` like everything else.
 */

export type MindMapStatus = "pending" | "active" | "done" | "failed";

export interface MindMapNode {
  id: string;
  kind: "root" | "stage" | "item";
  stage?: StageId;
  /** Data, not wording: a task's first line, a port group's name, a step name. */
  label?: string;
  status: MindMapStatus;
  /** 0–100, or null while a step with no measure runs. */
  percent: number | null;
  /** True when `percent` comes from turns used, not from finished work. */
  estimate: boolean;
  turns?: number;
  maxTurns?: number;
  /** The build check after a Coding task: not run, running, passed, failed. */
  check?: MindMapStatus;
  notes?: StepState["notes"];
  children: MindMapNode[];
}

/** The most a running agent step shows: reaching the cap is not finishing. */
const MAX_RUNNING_PERCENT = 95;

export function buildMindMap(state: RunState): MindMapNode {
  const stageIds = STAGE_IDS_BY_MODE[state.mode] ?? [];
  const stages = stageIds.map((stage) => stageNode(state, stage));
  return {
    id: "run",
    kind: "root",
    status: runStatus(state),
    percent: state.status === "done" ? 100 : mean(stages.map((node) => node.percent)),
    estimate: stages.some((node) => node.estimate),
    children: stages,
  };
}

function stageNode(state: RunState, stage: StageId): MindMapNode {
  const steps = Object.entries(state.steps).filter(([, step]) => step.stage === stage);
  const children = stage === "coding" ? codingItems(state, steps) : stage === "port" ? portItems(state, steps) : [];
  const own = children.length ? [] : steps;
  // A stage with several steps of its own (two scans, build/test/fix rounds) lists them.
  const listed = own.length > 1 ? own.map(([name, step]) => stepNode(name, step)) : [];
  const single = own.length === 1 ? stepNode(own[0][0], own[0][1]) : null;

  const status = stageStatus(state, stage, [...children, ...listed, ...(single ? [single] : [])]);
  const parts = children.length ? children : listed;
  let percent: number | null;
  if (status === "done") percent = 100;
  else if (status === "pending") percent = 0;
  else if (parts.length) percent = mean(parts.map((node) => node.percent));
  else percent = single ? single.percent : null;

  return {
    id: stage,
    kind: "stage",
    stage,
    status,
    percent,
    estimate: status !== "done" && (single?.estimate ?? parts.some((node) => node.estimate && node.status === "active")),
    ...(single?.turns !== undefined ? { turns: single.turns, maxTurns: single.maxTurns } : {}),
    ...(single ? { notes: single.notes } : {}),
    children: children.length ? children : listed,
  };
}

/** The baseline check (when it ran), then one node per planned task with its own check folded in. */
function codingItems(state: RunState, steps: [string, StepState][]): MindMapNode[] {
  const byName = new Map(steps);
  const planned = state.plan.coding ?? steps
    .filter(([name]) => name.startsWith("coding:"))
    .map(([name]) => ({ id: name.slice("coding:".length), label: name.slice("coding:".length) }));
  const items: MindMapNode[] = [];
  const baseline = byName.get("gate:baseline");
  if (baseline) items.push({ ...stepNode("gate:baseline", baseline), label: "gate:baseline" });
  const checked = steps.some(([name]) => name.startsWith("gate:"));

  for (const { id, label } of planned) {
    const code = byName.get(`coding:${id}`);
    const gate = byName.get(`gate:${id}`);
    const codeNode = code ? stepNode(`coding:${id}`, code) : null;
    const check: MindMapStatus = gate ? (gate.status === "active" ? "active" : gate.status) : "pending";
    const status: MindMapStatus =
      codeNode?.status === "failed" || check === "failed"
        ? "failed"
        : codeNode?.status === "active" || check === "active"
          ? "active"
          : codeNode?.status === "done" && (!checked || check === "done")
            ? "done"
            : "pending";
    const codePercent = codeNode?.percent ?? 0;
    // The check is a small, quick part of a task; the code is most of it.
    const percent = !checked
      ? codePercent
      : status === "done"
        ? 100
        : Math.round(codePercent * 0.85 + (check === "active" ? 7 : check === "done" || check === "failed" ? 15 : 0));
    items.push({
      id: `task:${id}`,
      kind: "item",
      stage: "coding",
      label,
      status,
      percent,
      estimate: codeNode?.estimate ?? false,
      ...(codeNode?.turns !== undefined ? { turns: codeNode.turns, maxTurns: codeNode.maxTurns } : {}),
      ...(checked ? { check } : {}),
      ...(code ? { notes: code.notes } : {}),
      children: [],
    });
  }
  return items;
}

function portItems(state: RunState, steps: [string, StepState][]): MindMapNode[] {
  const byName = new Map(steps);
  const planned = state.plan.port ?? steps.map(([name]) => ({ id: name.slice("port:".length), label: name.slice("port:".length) }));
  return planned.map(({ id, label }) => {
    const step = byName.get(`port:${id}`);
    return step ? { ...stepNode(`port:${id}`, step), label } : pendingItem(`port:${id}`, "port", label);
  });
}

function stepNode(name: string, step: StepState): MindMapNode {
  const plainCode = name.startsWith("gate:");
  let percent: number | null;
  if (step.status === "done") percent = 100;
  else if (plainCode) percent = step.status === "failed" ? 100 : null;
  else percent = turnPercent(step);
  return {
    id: name,
    kind: "item",
    stage: step.stage,
    label: name,
    status: step.status,
    percent,
    estimate: !plainCode && step.status !== "done",
    ...(step.turns !== undefined ? { turns: step.turns, maxTurns: step.maxTurns } : {}),
    notes: step.notes,
    children: [],
  };
}

function pendingItem(id: string, stage: StageId, label: string): MindMapNode {
  return { id, kind: "item", stage, label, status: "pending", percent: 0, estimate: false, children: [] };
}

function turnPercent(step: StepState): number {
  if (!step.turns || !step.maxTurns) return 0;
  return Math.min(MAX_RUNNING_PERCENT, Math.round((step.turns / step.maxTurns) * 100));
}

/**
 * The stage the run stopped in is the failed one. A failed step inside a stage
 * the run went past — a build that failed and was then fixed — does not fail
 * the stage. (The runner adds the last stage to `completedStages` when the
 * process ends, hence the order of the checks.)
 */
function stageStatus(state: RunState, stage: StageId, parts: MindMapNode[]): MindMapStatus {
  const current = state.stage === stage;
  if (current && state.status === "running") return "active";
  if (current && state.status !== "done" && state.status !== "idle") return "failed";
  if (state.completedStages.includes(stage)) return "done";
  if (parts.some((node) => node.status !== "pending")) return "active";
  return "pending";
}

function runStatus(state: RunState): MindMapStatus {
  if (state.status === "running") return "active";
  if (state.status === "done") return "done";
  if (state.status === "idle") return "pending";
  return "failed";
}

/** The mean percent, counting an unmeasured running part as half done. */
function mean(values: (number | null)[]): number {
  if (!values.length) return 0;
  const total = values.reduce<number>((sum, value) => sum + (value ?? 50), 0);
  return Math.round(total / values.length);
}
