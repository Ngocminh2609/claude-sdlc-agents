/**
 * Wire contract between the pipeline CLI (`src/index.ts`) and a front end that
 * runs it as a child process — today, the local web UI in `src/ui/`.
 *
 * Why a second output channel instead of reading the terminal output: the
 * CLI's human output (`[pipeline] Coding: task-1 (attempt 1/3)`) is written
 * for a person reading a terminal. A UI that scraped those strings would keep
 * "working" while silently tracking nothing the day someone reworded a
 * message. With `AIDEV_EVENT_STREAM=1` the CLI writes one JSON object per line
 * instead, so the front end parses a shape rather than prose.
 *
 * It is opt-in because plain text is the right default for a human at a
 * terminal — with the variable unset the CLI behaves exactly as before.
 *
 * The stream is deliberately line-based and mixed with ordinary output: any
 * line that is not a valid event is just log text (the Agent SDK and the
 * target project's own build tools write to the same stdout/stderr), so a
 * reader keeps both without needing a second pipe.
 */

export const EVENT_STREAM_ENV = "AIDEV_EVENT_STREAM";

/** A stage boundary or per-attempt heartbeat from `runPipeline`'s onProgress. */
export interface PipelineProgressEvent {
  type: "progress";
  message: string;
}

/** Terminal event for a run that reached a pipeline verdict of its own. */
export interface PipelineFinishedEvent {
  type: "finished";
  status: string;
  message: string;
  logPath?: string;
}

/** Terminal event for a run that threw before producing a verdict. */
export interface PipelineCrashedEvent {
  type: "crashed";
  message: string;
}

export type PipelineEvent = PipelineProgressEvent | PipelineFinishedEvent | PipelineCrashedEvent;

export function eventStreamEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[EVENT_STREAM_ENV] === "1";
}

export function encodeEvent(event: PipelineEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/**
 * Returns the event a line carries, or null when the line is ordinary log
 * output. Fail-closed on anything malformed: a half-written line or a log
 * message that happens to start with `{` must degrade to log text, never to a
 * half-populated event the UI would render as real state.
 */
export function parseEventLine(line: string): PipelineEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;

  switch (candidate.type) {
    case "progress":
      return typeof candidate.message === "string"
        ? { type: "progress", message: candidate.message }
        : null;
    case "finished":
      if (typeof candidate.status !== "string" || typeof candidate.message !== "string") return null;
      return {
        type: "finished",
        status: candidate.status,
        message: candidate.message,
        ...(typeof candidate.logPath === "string" ? { logPath: candidate.logPath } : {}),
      };
    case "crashed":
      return typeof candidate.message === "string"
        ? { type: "crashed", message: candidate.message }
        : null;
    default:
      return null;
  }
}
