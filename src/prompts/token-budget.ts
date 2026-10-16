/**
 * How an agent with Bash keeps its own session cheap, for every stage that has
 * one (Coding, E2E, the clone port/fix/build/test stages).
 *
 * Every turn re-sends the whole context, so a session costs roughly turns x
 * context. On real transcripts (2026-10-15/16) the waste was the same in every
 * stage that had these rules missing: the same files read two and three times
 * (a Bash `cat`, then Read, then `cat` again), long command output kept for
 * the rest of the session, and one tool call per turn where several were
 * independent. The Coding stage had the rules; the E2E stage did not, and its
 * runs were the most expensive step of every feature run measured.
 */
export const TOKEN_BUDGET_RULES = `TOKEN BUDGET — every turn re-sends your whole context, so the cost of this
session is roughly (number of turns) x (context size). Work in few, full turns:
- Batch. Put every independent tool call of a step in ONE response: read all
  the files you need at once (several Read calls side by side), then write or
  edit all independent files at once. One call per turn is the expensive way.
- Read each file once, with the Read tool. Never cat/head/sed/type a file
  through Bash as well, and never read again a file whose content is already in
  your context — that pays for it twice. For a large file, Read only the range
  you need (offset/limit).
- Command output stays in your context for the rest of the session: use quiet
  flags (mvn -q, npm --silent, gradle -q), pipe long output through
  "tail -n 60" or grep for the errors, and run a long build or test suite once
  you are done editing rather than after every file.`;
