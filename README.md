# Arjun

Runs Claude Code tasks unattended. People create tasks in the web UI, other services create them through the API, and a Docker container runs each one with `claude -p` on a Max plan, or on several, one after another (see [Claude accounts](#claude-accounts)). Claude reports how it went with the `update_run` command, and any task can be continued with new instructions.

## How it works

- **One container.** A Fastify server serves the React UI and the API, and a dispatcher starts queued runs, up to the limit set on the Settings page (default 5), priority 1 first.
- **Each run** is `claude -p "<prompt>" --session-id … --model … --effort … --dangerously-skip-permissions`, working in `~/runs/<run_id>/`.
- **The prompt** tells Claude it's on its own and must finish by running `update_run done|stuck|error "<summary>"`. That command reports to the server over localhost using the `RUN_ID` the server set.
- **Continue** resumes the same Claude session (`--resume`) in the same folder, with new instructions.
- **History** is Claude's own session file in `~/.claude/projects`, kept 60 days (the server sets `cleanupPeriodDays` on first start).
- **Usage limit:** the run is marked `limited` and a continue is queued automatically. It starts on the next Claude account with room, or, if there's only one account, after the reset time.
- Everything that must survive a redeploy is in `/home/node`, the one volume: Claude's logins and history, `data/arjun.db`, and `runs/`.

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

## What runs get from Arjun

The Claude accounts only provide usage. Everything else a run needs comes from Arjun itself, the same whichever account the run lands on. Settings → **From Arjun** shows what that is and whether it's working, and **Check now** checks it all again.

- **Plugins.** Arjun keeps its own copy of the mytribe plugin, the `packages/shared/plugin` folder of `tr-ibe/mytribe` on `main`. It fetches just that folder, checks for a new version every 10 minutes (or on **Check now**), and loads it into every run with `--plugin-dir`. It's the same plugin claude.ai syncs to mytribe-core logins, but it doesn't depend on which login a run uses. On a login that also gets the synced copy, Claude uses Arjun's and skips its own. The repo is private, so Arjun reads it with the GitHub CLI's login in the container: run `gh auth login` once (see [SETUP.md](SETUP.md#3-log-in-in-the-containers-terminal)). If an update fails, runs keep the copy Arjun already has. `PLUGINS` changes the list.
- **The mytribe CLI's sign-in.** The CLI keeps it in the container's home folder (`~/.mytribe`), not in a Claude account, so every run uses the same one: arjun@mytribe.in. It renews itself, and several runs can share it at once. Arjun runs `mytribe status` every 10 minutes and shows who it's signed in as. If the sign-in ends, sign in again in the container's terminal: `mytribe login arjun@mytribe.in`, then `mytribe login --code <code>` with the code from the email. (`mytribe` runs the CLI from Arjun's copy of the plugin.)
- **Slack.** Every run gets Slack's own MCP server (`mcp.slack.com`), signed in with Arjun's Slack user token (`SLACK_USER_TOKEN`), so it reads and posts as Arjun whichever Claude account it's on. The account's claude.ai Slack connector is hidden from the run (a `permissions.deny` rule), since it may be signed in as someone else. The token reaches Claude only as the environment variable the MCP config refers to, never on the command line. A run can read it, so it's no more secret than what Arjun's Slack user can do. Arjun checks every 10 minutes that the token works and that Slack's MCP server lets the app in. To set it up, see [SETUP.md → The Slack app](SETUP.md#1-the-slack-app).

## Claude accounts

Arjun can use several Claude logins, tried in order. The first account takes every run until it has used 85% of its 5-hour window (or 95% of its week). After that, runs go to the second account, then the third, and so on, for as many accounts as you add. When every account is past that point, the first one with any room left is used. Only when none has room do runs wait, until the earliest reset. You can change both percentages on the Settings page.

- **Before each run** the dispatcher picks the account. It uses the usage Claude reports for each account (the endpoint behind Claude Code's `/usage`). That endpoint rate-limits, so the server reads it only as often as routing needs: every 3 minutes for the account new runs go to and accounts with runs on them, every 15 minutes for the rest, and again when a run ends if the last reading is over a minute old. If it answers "rate limited", that account is left alone for 5 minutes, then 10, 20 and at most 30, and its last reading is used meanwhile.
- **If a run hits the limit anyway** (several runs started on an account that was just under the line), that account is skipped until its reset. The task continues straight away on the next account, in the same Claude session and folder. A run whose login stopped working is handled the same way, and its account shows **Needs login** until someone logs it in again.
- **The usage endpoint isn't documented.** If it can't be read, the account is still used, and Arjun switches when Claude says the limit was reached.
- **Settings → Claude accounts** shows each account's usage, which one new runs go to, and buttons to reorder accounts or turn them off. Each attempt on a task shows which account it ran on.

### Where the accounts live

| Account | Folder | How it's logged in |
|---|---|---|
| main (always first at the start) | `/home/node/.claude` | `claude`, then `/login` |
| every extra account | `/home/node/accounts/<name>` | `add-account <name>` |

Each extra folder links `projects` (every session) and your instructions, agents and commands to the main folder. That way any account can resume any session. Its login, `.claude.json` (MCP servers), `settings.json`, and the plugins and skills claude.ai syncs to it belong to that account. Plugins every run should have come from Arjun instead (see [What runs get from Arjun](#what-runs-get-from-arjun)).

### Adding, removing and swapping accounts

In the container's terminal, `add-account <name>`, then `/login` and `/exit`. The account joins the end of the order. [SETUP.md → Claude accounts](SETUP.md#claude-accounts) has the steps for adding, removing, logging in again and putting a different subscription behind an account.

## Deploy on Coolify

[SETUP.md](SETUP.md) has every step: the Slack app, the Coolify app and its environment variables, the logins in the container (Claude, GitHub, the mytribe CLI), API keys and the checks, plus how to move Arjun to another server. Coolify doesn't deploy on a push to `main`; press **Deploy** in Coolify.

### Deploying while tasks are running

A deploy replaces the container, which stops every Claude process in it. To deploy without cutting anything off:

1. Press **Pause new runs** at the top right of the web UI. Running tasks carry on, and nothing new starts. New tasks and Slack messages wait in the queue.
2. Wait until the banner says nothing is running.
3. Press **Deploy** in Coolify.
4. Press **Resume** in the banner. The pause outlasts the deploy, so the queue stays paused until you do.

If you can't wait, deploy anyway. Any run that was still going ends as "Interrupted by a server restart" and continues by itself after the restart, in the same Claude session and folder, with a note that the server restarted. When something was already queued to follow it (a Slack reply, or a Continue), that attempt picks it up instead. After three restarts in a row cut off the same task, it waits for someone to press **Continue**.

## Environment variables

| Variable | Needed | Purpose |
|---|---|---|
| `AUTH_USERNAME`, `AUTH_PASSWORD` | yes | The one login for the web UI |
| `SESSION_SECRET` | yes | Signs the login cookie. Long random string. |
| `SLACK_USER_TOKEN`, `SLACK_APP_TOKEN` | no | Turn on Slack, see below |
| `SLACK_ALLOWED_USERS` | no | Slack user IDs who may talk to Arjun, comma-separated. Default: every full member of the workspace (no guests, no bots). |
| `OPENAI_API_KEY` | no | Passed through to Claude Code runs |
| `PLUGINS` | no | Plugins every run gets, as `<git url>#<folder>`, comma-separated. Default: `https://github.com/tr-ibe/mytribe.git#packages/shared/plugin`. Empty for none. |
| `PORT` | no | Default 3000 |

Everything else (max concurrency, when to switch accounts, default model, effort, priority, timeout) is on the Settings page. Claude accounts are added in the container, not with variables.

## Slack

People talk to Arjun in Slack like a colleague: DM him, or @-mention him in a channel. The server is only the orchestrator. Claude Code reads the thread and replies with its own Slack tools (Slack's MCP server, as Arjun's Slack user), and the server never posts anything.

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

[SETUP.md → The Slack app](SETUP.md#1-the-slack-app) has the Slack app's settings and scopes. Set `SLACK_USER_TOKEN` and `SLACK_APP_TOKEN` in Coolify and deploy; the log then says `Slack is on, as …`. Arjun only hears channels he's a member of, so invite him to the ones he should be in.

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

Each attempt in `runs` has `account_name`, the Claude account it ran on.

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
