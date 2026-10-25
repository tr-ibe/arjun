import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { db, insertRun, insertTask, latestRun, now } from "./db.js";
import { kick } from "./dispatcher.js";
import { getSettings } from "./settings.js";

// The Slack orchestrator. It only listens: one Slack thread is one task, and so one Claude Code
// session. A new thread starts the session, and every later message in the thread wakes the same
// session again. Claude reads the thread and replies with its own Slack tools; nothing here posts.

// The message events Slack sends (message.im, message.channels, message.groups, message.mpim).
export interface SlackEvent {
  type: string;
  subtype?: string;
  channel: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
}

interface Slack {
  selfId: string;
  // Whether this person may talk to Arjun: a full member of the workspace, or on the allowlist.
  allowed(userId: string): Promise<boolean>;
  permalink(channel: string, ts: string): Promise<string | null>;
}

// Message subtypes that are still someone writing; the rest are edits, joins and so on.
const HANDLED_SUBTYPES = ["file_share", "thread_broadcast"];
// Slack conversations start on these rather than the Settings defaults. Every later turn in the
// thread keeps the task's model and effort, and a task can still be changed from the console.
const SLACK_MODEL = "claude-sonnet-5-5";
const SLACK_EFFORT = "medium";

let slack: Slack | null = null;

// Tests call this with a fake; startSlack calls it with the real thing.
export function useSlack(next: Slack): void {
  slack = next;
}

export async function startSlack(log: { info: (m: string) => void; error: (o: unknown, m: string) => void }) {
  const userToken = process.env.SLACK_USER_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  if (!userToken || !appToken) {
    log.info("Slack is off (set SLACK_USER_TOKEN and SLACK_APP_TOKEN to turn it on)");
    return;
  }

  const web = new WebClient(userToken);
  const auth = await web.auth.test();
  const allowlist = (process.env.SLACK_ALLOWED_USERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const members = new Map<string, boolean>();

  useSlack({
    selfId: auth.user_id!,
    async allowed(userId) {
      if (allowlist.length) return allowlist.includes(userId);
      if (!members.has(userId)) {
        const { user } = await web.users.info({ user: userId });
        members.set(
          userId,
          !!user && !user.deleted && !user.is_bot && !user.is_restricted && !user.is_ultra_restricted && user.team_id === auth.team_id,
        );
      }
      return members.get(userId)!;
    },
    async permalink(channel, ts) {
      return (await web.chat.getPermalink({ channel, message_ts: ts })).permalink ?? null;
    },
  });

  const socket = new SocketModeClient({ appToken });
  socket.on("message", async ({ event, ack }: { event: SlackEvent; ack: () => Promise<void> }) => {
    await ack();
    try {
      await handleMessage(event);
    } catch (err) {
      log.error(err, "slack: could not handle a message");
    }
  });
  await socket.start();
  log.info(`Slack is on, listening as ${auth.user} (${auth.user_id})`);
}

const threadTask = db.prepare("SELECT task_id FROM slack_threads WHERE channel = ? AND thread_ts = ?");
const seen = db.prepare("SELECT 1 FROM slack_messages WHERE channel = ? AND ts = ?");
const remember = db.prepare("INSERT INTO slack_messages (channel, ts, run_id, created_at) VALUES (?, ?, ?, ?)");

export async function handleMessage(event: SlackEvent): Promise<void> {
  if (!slack || event.type !== "message") return;
  if (event.subtype && !HANDLED_SUBTYPES.includes(event.subtype)) return;
  if (!event.user || event.bot_id || event.user === slack.selfId) return;

  const threadTs = event.thread_ts ?? event.ts;
  const known = !!threadTask.get(event.channel, threadTs);
  // In a DM everything is for Arjun. In a channel he starts a thread only when he's mentioned, and
  // once he's in it he hears every message there and decides himself whether it needs an answer.
  const forArjun = event.channel_type === "im" || (event.text ?? "").includes(`<@${slack.selfId}>`);
  if (!known && !forArjun) return;
  if (!(await slack.allowed(event.user))) return;

  const where = `channel ${event.channel}, thread_ts ${threadTs}`;
  const line = `- <@${event.user}> wrote (ts ${event.ts}): ${event.text ?? ""}`;

  // Nothing below awaits, so a message Slack delivers twice is handled once, and two messages
  // racing into a new thread can't start two sessions.
  if (seen.get(event.channel, event.ts)) return;
  const task = threadTask.get(event.channel, threadTs) as { task_id: number } | undefined;
  let runId: number;
  if (task) {
    runId = addToConversation(task.task_id, line);
  } else {
    const intro = `A Slack message for you (${where}). Read the whole thread with your Slack tools, work out what's needed, and reply in that thread.\n${line}`;
    const taskId = startConversation(event.channel, threadTs, event.text ?? "Slack thread", intro);
    runId = latestRun(taskId)!.id;
    void slack
      .permalink(event.channel, threadTs)
      .then((link) => db.prepare("UPDATE slack_threads SET permalink = ? WHERE task_id = ?").run(link, taskId))
      .catch(() => {});
  }
  remember.run(event.channel, event.ts, runId, now());
  kick();
}

function startConversation(channel: string, threadTs: string, text: string, prompt: string): number {
  const s = getSettings();
  return db.transaction(() => {
    const taskId = insertTask({
      title: text.replace(/<@[A-Z0-9]+>/g, "").trim().split("\n")[0].slice(0, 80) || "Slack thread",
      prompt,
      type: "slack",
      priority: s.default_priority,
      model: SLACK_MODEL,
      effort: SLACK_EFFORT,
      source: "slack",
      api_key_id: null,
      timeout_min: s.default_timeout_min,
    });
    db.prepare("INSERT INTO slack_threads (task_id, channel, thread_ts) VALUES (?, ?, ?)").run(taskId, channel, threadTs);
    return taskId;
  })();
}

// A message in a thread that already has a session. If the session's next turn hasn't started,
// the message joins it, so several quick messages become one turn. Otherwise it queues a new turn,
// which the dispatcher holds until the running one finishes, since both use the same session.
function addToConversation(taskId: number, line: string): number {
  return db.transaction(() => {
    const latest = latestRun(taskId)!;
    if (latest.status === "queued") {
      db.prepare("UPDATE runs SET instructions = instructions || ? WHERE id = ?").run(`\n${line}`, latest.id);
      return latest.id;
    }
    return insertRun({
      task_id: taskId,
      instructions: line,
      timeout_min: latest.timeout_min,
      resumed_from_run_id: latest.id,
    }).id;
  })();
}
