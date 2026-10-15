# Arjun

Runs Claude Code tasks unattended. People create tasks in the web UI, other services create them through the API, and a Docker container runs each one with `claude -p` on a Max plan. Claude reports how it went with the `update_run` command, and any task can be continued with new instructions.

The full design is in the [build plan](https://claude.ai/artifact/9YzwHpqQaB4r1MpxzYEWnm).

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
| `PORT` | no | Default 3000 |

Everything else (max concurrency, default model, effort, priority, timeout) is on the Settings page.

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
- Every run shares the container's user, so runs can read each other's folders and Claude's login. The container is the boundary: don't mount the Docker socket or host folders into it.
