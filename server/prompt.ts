import type { RunRow } from "./db.js";

const RULES = `You are working on this task on your own. Nobody is watching and nobody will answer questions, so never ask for clarification or confirmation. When something is unclear, choose the most reasonable option, note the assumption, and keep going. If you truly cannot continue (missing access, missing information, a broken dependency), stop and report it as stuck. Don't guess at anything risky or irreversible.`;

const REPORTING = `## Reporting (required)
When you finish, run exactly one of these shell commands:
  update_run done "<what you did, and where the result is: PR link, Slack message, records changed>"
  update_run stuck "<what blocked you, what you tried, and what a person needs to do>"
  update_run error "<what failed, with the error message>"
If you end without running update_run, the run is marked as an error.`;

export function firstPrompt(instructions: string): string {
  return `${RULES}\n\n## Task\n${instructions}\n\n${REPORTING}`;
}

export function continuePrompt(previous: RunRow, message: string): string {
  const outcome = previous.summary ?? previous.error ?? "no summary";
  return `The previous attempt ended as "${previous.status}": ${outcome}

## New instructions
${message}

Same rules as before: nobody will answer questions, and when you finish, report with update_run.

${REPORTING}`;
}

export const USAGE_LIMIT_MESSAGE =
  "You were interrupted because the Claude usage limit was reached. It has reset now. Pick up where you left off and finish the task.";
