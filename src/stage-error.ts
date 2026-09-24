/**
 * A stage failure whose message this repo wrote itself — stage name, task id,
 * and the SDK's own reason code — so it is safe to show the user verbatim.
 *
 * The pipelines' top-level catch still hides every other error behind a
 * generic message, because a raw exception can carry stack frames and paths.
 * This class is the line between the two: without it, a usage limit hit in the
 * middle of a run reached the user as "an unexpected error occurred", which
 * said nothing about waiting for the limit to reset.
 */
export class StageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StageError";
  }
}
