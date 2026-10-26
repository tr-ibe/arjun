# Arjun

Runs Claude Code tasks unattended. People create tasks in the web UI, other services create them through the API, and a Docker container runs each one with `claude -p` on a Max plan. Claude reports how it went with the `update_run` command, and any task can be continued with new instructions.

## How it works

- **One container.** A Fastify server serves the React UI and the API, and a dispatcher starts queued runs, up to the limit set on the Settings page (default 5), priority 1 first.
- **Each run** is `claude -p "<prompt>" --session-id … --model … --effort … --dangerously-skip-permissions`, working in `~/runs/<run_id>/`.
- **The prompt** tells Claude it's on its own and must finish by running `update_run done|stuck|error "<summary>"`. That command reports to the server over localhost using the `RUN_ID` the server set.
- **Continue** resumes the same Claude session (`--resume`) in the same folder, with new instructions.
- **History** is Claude's own session file in `~/.claude/projects`, kept 60 days (the server sets `cleanupPeriodDays` on first start).
- **Usage limit:** the run is marked `limited`, new runs wait until the reset time, and a continue is queued automatically.
- Everything that must survive a redeploy is in `/home/node`, the one volume: Claude's login and history, `data/arjun.db`, and `runs/`.

## Run it locally with Docker

```bash
cp .env.example .env    # then set AUTH_PASSWORD and SESSION_SECRET
```

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build -d
```

Log Claude in inside the container, once. The login is saved in the volume.

```bash
docker compose exec arjun claude
```

In Claude, run `/login`, sign in with the Max account, then `/exit`.

Open http://localhost:3000, log in with `AUTH_USERNAME` / `AUTH_PASSWORD`, and try a first task, e.g.:

> Create a file called hello.txt containing today's date and the output of `uname -a`.

Check that it ends as **Done** with a summary, that the timeline shows each step, and that **Continue** (e.g. "Also add the Node version to hello.txt") picks up in the same folder.

## Deploy on Coolify

1. **New resource → Docker Compose**, pointing at this repo and branch. Coolify uses `docker-compose.yml`.
2. **Environment variables:** fill in `AUTH_USERNAME`, `AUTH_PASSWORD` and `SESSION_SECRET` (e.g. `openssl rand -hex 32`).
3. **Domain:** set one on the `arjun` service, port `3000`. Coolify's proxy handles HTTPS.
4. **Deploy.** Coolify builds the image and creates the `arjun-home` volume.
5. **Log Claude in:** open the container's **Terminal** in Coolify (it's already the `node` user), run `claude`, then `/login`, then `/exit`.
6. **Create API keys** on the API keys page, one per caller (mytribe, trigger, agent0, …).

A deploy restarts the container, which stops any running Claude processes. Those runs are marked "interrupted by restart" and can be continued. Deploy when nothing is running.

## Environment variables

| Variable | Needed | Purpose |
|---|---|---|
| `AUTH_USERNAME`, `AUTH_PASSWORD` | yes | The one login for the web UI |
| `SESSION_SECRET` | yes | Signs the login cookie. Long random string. |
| `SLACK_USER_TOKEN`, `SLACK_APP_TOKEN` | no | Turn on Slack, see below |
| `SLACK_ALLOWED_USERS` | no | Slack user IDs who may talk to Arjun, comma-separated. Default: every full member of the workspace (no guests, no bots). |
| `OPENAI_API_KEY` | no | Passed through to Claude Code runs |
| `PORT` | no | Default 3000 |

Everything else (max concurrency, default model, effort, priority, timeout) is on the Settings page.

## Slack

People talk to Arjun in Slack like a colleague: DM him, or @-mention him in a channel. The server is only the orchestrator. Claude Code reads the thread and replies with its own Slack tools (the Slack connector on Arjun's Claude login), and the server never posts anything.

- **One Slack thread is one task, and so one Claude Code session.** A DM, or a message that mentions Arjun, starts a session and tells it which thread to read and answer. The thread ⇄ session mapping is in `slack_threads`.
- **A new message in a known thread resumes that same session** (`--resume`): right away if it's idle. If it's busy, the message waits, and everything that arrived meanwhile goes in as one next turn.
- **In a channel thread he's part of, he hears every message** and decides for himself whether one needs an answer. Channel messages that don't mention him, outside his threads, are ignored, as are bots, edits and his own messages.
- **Only full members of the workspace** can start or continue a thread (no guests), or only the people in `SLACK_ALLOWED_USERS` if it's set.
- **Slack conversations run on Sonnet 5.5 at medium effort** (`claude-sonnet-5-5`, set in `server/slack.ts`), not the Settings defaults. Every turn in a thread keeps that.
- Slack tasks show up in the task list with the source **Slack** and a link to the thread.

### Guardrails

Work asked for on Slack is **read-only, except for code, which goes up as a pull request.** He finds information, answers, and may post in other channels and DMs, but he never creates, changes or deletes data anywhere, never deploys, never messages customers, never pushes to main and never merges.

1. **The prompt** (`server/prompt.ts`) says so, and says no Slack message can override it.
2. **A `PreToolUse` hook** (`cli/slack_guard.ts`) is added to every Slack run with `--settings` and blocks tool calls that change things:
   - MCP tools by name: reading is allowed. Anything that sounds like a change is blocked, except sending a Slack message, adding a reaction, creating a branch, opening a pull request, and pushing files to a branch that isn't main.
   - Shell commands: `mytribe post/patch/delete`, direct database access, cloud and deploy tools, pushing to main or force-pushing, merging pull requests, changing GitHub issues and releases, and HTTP requests that send data.

The shell rules are a backstop, not a sandbox: a determined script could still get round them. The container is the real boundary, so keep write credentials it doesn't need out of it.

### Setting it up

In the Slack app at [api.slack.com/apps](https://api.slack.com/apps):

1. **Socket Mode:** turn it on and create an app-level token with `connections:write`. That's `SLACK_APP_TOKEN` (`xapp-…`). Socket Mode means Slack never needs to reach the server.
2. **OAuth & Permissions → User Token Scopes:** `users:read`, `im:history`, `channels:history`, `groups:history`, `mpim:history`. The listener only reads; replies go through Claude's connector.
3. **Event Subscriptions:** turn them on, and under **Subscribe to events on behalf of users** add `message.im`, `message.channels`, `message.groups` and `message.mpim`.
4. **Install the app while signed in to Slack as Arjun**, so he is the one who authorises it. The **User OAuth Token** (`xoxp-…`) is `SLACK_USER_TOKEN`.
5. Set both tokens as environment variables (in Coolify, on the `arjun` service) and redeploy. The log says `Slack is on, as …`.

Arjun only hears channels he's a member of, so invite him to the ones he should be in. Claude Code in the container must also have the Slack connector, signed in as the same Arjun account, since that's how it reads and replies.

## Calling the API

Create a key on the API keys page, then:

```bash
curl -X POST https://arjun.example.com/api/tasks \
  -H "Authorization: Bearer ak_…" -H "Content-Type: application/json" \
  -d '{"title":"Build profile for provider 812","prompt":"…","type":"provider-profile","priority":3,"timeout_min":20}'
```

Only `prompt` is required; the rest falls back to the defaults on the Settings page.

| Endpoint | Does |
|---|---|
| `POST /api/tasks` | Create a task: `{prompt, title?, type?, priority? (1 highest–10), model?, effort?, timeout_min?}` |
| `GET /api/tasks/:id` | The task with every attempt. The latest is `latest_run`, with `status` and `summary`. |
| `POST /api/tasks/:id/continue` | `{message, timeout_min?}`: continue with new instructions |
| `POST /api/runs/:id/cancel` | Cancel a queued or running attempt |
| `GET /api/tasks` | List, filter with `status`, `type`, `source`, `q` |
| `GET /api/tasks/:id/timeline` | Every step Claude took |
| `GET /api/meta` | Allowed models and efforts, and the current defaults |

Statuses: `queued`, `running`, `done`, `stuck`, `error`, `timeout`, `limited`, `cancelled`. Poll `GET /api/tasks/:id` until it's no longer `queued` or `running`.

## Development

```bash
npm install && npm --prefix web install
npm test          # builds, then runs the server against a fake Claude (scripts/fake-claude.mjs)
npm run build && sh scripts/demo.sh   # the UI at :3000 with the fake Claude, login admin / demo
```

`npm run dev` and `npm run dev:web` run the server and the UI with live reload (set the environment variables first).

## Known gaps

- **The usage-limit message** is recognised from Claude Code's output (`server/limit.ts`). Its exact wording has changed between versions, so check the first real one and adjust the pattern if needed. If the reset time can't be read, the queue waits 30 minutes and tries again.
- **A deploy cuts off a Slack turn** like any other run. Nothing is posted to the thread; use Continue on the task, or the next message in the thread picks the conversation up again.
- Every run shares the container's user, so runs can read each other's folders and Claude's login. The container is the boundary: don't mount the Docker socket or host folders into it.
