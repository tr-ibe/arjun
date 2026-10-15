import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

// One step of a run, read from Claude Code's own session file.
export interface TimelineEntry {
  at: string | null;
  kind: "prompt" | "text" | "thinking" | "tool_use" | "tool_result";
  text?: string;
  tool?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
}

const MAX_CHARS = 20_000;

function clip(s: string): string {
  return s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}\n… (${s.length - MAX_CHARS} more characters)` : s;
}

function clipInput(input: unknown): unknown {
  const json = JSON.stringify(input ?? null);
  return json.length > MAX_CHARS ? { truncated: clip(json) } : input;
}

// Claude Code keeps sessions in ~/.claude/projects/<working folder with symbols replaced>/<id>.jsonl.
// Search by file name rather than rebuilding that folder name, in case the naming changes.
export function findSessionFile(sessionId: string): string | null {
  const root = join(config.claudeConfigDir, "projects");
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root)) {
    const file = join(root, dir, `${sessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: { type?: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`))
      .join("\n");
  }
  return "";
}

export function readTimeline(sessionId: string): TimelineEntry[] | null {
  const file = findSessionFile(sessionId);
  if (!file) return null;

  const entries: TimelineEntry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if ((row.type !== "user" && row.type !== "assistant") || row.isSidechain || row.isMeta) continue;

    const at: string | null = row.timestamp ?? null;
    const fromUser = row.type === "user";
    const content = row.message?.content;

    if (typeof content === "string") {
      if (content.trim()) entries.push({ at, kind: fromUser ? "prompt" : "text", text: clip(content) });
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type === "text" && block.text?.trim()) {
        entries.push({ at, kind: fromUser ? "prompt" : "text", text: clip(block.text) });
      } else if (block.type === "thinking" && block.thinking?.trim()) {
        entries.push({ at, kind: "thinking", text: clip(block.thinking) });
      } else if (block.type === "tool_use") {
        entries.push({ at, kind: "tool_use", tool: block.name, input: clipInput(block.input), tool_use_id: block.id });
      } else if (block.type === "tool_result") {
        entries.push({
          at,
          kind: "tool_result",
          text: clip(resultText(block.content)),
          tool_use_id: block.tool_use_id,
          is_error: Boolean(block.is_error),
        });
      }
    }
  }
  return entries;
}
