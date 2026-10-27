# Setting Arjun up

How to set Arjun up from nothing, move him to another server, and add or remove Claude accounts. For how Arjun works, see the [README](README.md).

## What Arjun is made of

The Claude accounts only provide usage. Everything else a run needs belongs to Arjun, and each piece has its own login:

| Piece | Who it is | Where it's set up | Where it's kept |
|---|---|---|---|
| Web UI login | `AUTH_USERNAME` / `AUTH_PASSWORD` | Coolify environment variables | Coolify |
| Slack (listening and replying) | Arjun's Slack user, `arjun303` | The Slack app (`A0CC0LML341`), tokens in Coolify | Coolify |
| GitHub (to fetch the mytribe plugin) | GitHub user `arjun-mytribe` | `gh auth login` in the container | `~/.config/gh` |
| mytribe CLI (mytribe's data) | `arjun@mytribe.in` | `mytribe login` in the container | `~/.mytribe` |
| Claude accounts (usage only) | One per Claude subscription | `claude` and `add-account` in the container | `~/.claude`, `~/accounts/<name>` |

Everything under `~` is the container's home folder, `/home/node`. It's the Docker volume `arjun-home` (Coolify names it `<app uuid>_arjun-home`; today that's `7adrkgbo3igmnl3pwbclp2hu_arjun-home` on apps-04). Besides the logins above, it holds the database (`~/data/arjun.db`: tasks, runs, API keys, settings, the account order), every Claude session (`~/.claude/projects`), the run folders (`~/runs`) and Arjun's copy of the mytribe plugin (`~/plugins`).

So there are two ways to set Arjun up somewhere new:

- **[Moving him](#moving-arjun-to-another-server):** copy the volume. Every login, task, session and API key comes along, and only the environment variables need setting again. Use this whenever the old server is still there.
- **[Starting from nothing](#setting-up-from-nothing):** a fresh volume, so every login is done again and API keys are made again.

## Moving Arjun to another server

1. **Stop new work on the old server.** In the web UI, press **Pause new runs** and wait until the banner says nothing is running.
2. **Copy the environment variables** from the old app in Coolify (the `arjun` service's **Environment Variables**). They aren't in the volume.
3. **Create the app on the new server** in Coolify, as in [step 2 below](#2-create-the-app-in-coolify), with the same environment variables. Deploy once, so Coolify creates the new volume, then **Stop** it.
4. **Stop the old app** in Coolify. Two Arjuns connected to Slack at once would split the Slack messages between them.
5. **Copy the volume.** On the old host:
   ```bash
   sudo docker run --rm -v 7adrkgbo3igmnl3pwbclp2hu_arjun-home:/v -v "$PWD":/backup alpine tar czf /backup/arjun-home.tgz -C /v .
   ```
   Copy `arjun-home.tgz` to the new host (for example with `scp` through your own computer). On the new host, with `<new uuid>` from the new app's volume (`sudo docker volume ls | grep arjun-home`):
   ```bash
   sudo docker run --rm -v <new uuid>_arjun-home:/v -v "$PWD":/backup alpine sh -c 'rm -rf /v/..?* /v/.[!.]* /v/*; tar xzf /backup/arjun-home.tgz -C /v'
   ```
6. **Start the new app**, then do [the checks](#5-check-everything). The queue is still paused (the pause is in the database): press **Resume** in the banner.
7. Point the domain at the new server if it changed, and delete the old app once you're happy.

## Setting up from nothing

### 1. The Slack app

Skip this if Arjun's Slack app (`A0CC0LML341`) still exists: its tokens are what Coolify needs. To make a new one, at [api.slack.com/apps](https://api.slack.com/apps), **Create New App → From scratch**, in the mytribe workspace:

1. **Socket Mode:** turn it on and create an app-level token with the scope `connections:write`. That's `SLACK_APP_TOKEN` (`xapp-…`).
2. **OAuth & Permissions → User Token Scopes.** For listening: `users:read`, `im:history`, `channels:history`, `groups:history`, `mpim:history`. For Claude's Slack tools: `search:read.public`, `search:read.private`, `search:read.im`, `search:read.mpim`, `search:read.files`, `search:read.users`, `chat:write`, `reactions:read`, `reactions:write`, `im:read`, `im:write`, `mpim:read`, `mpim:write`, `channels:read`, `groups:read`, `users:read.email`, `files:read`, `files:write`, `canvases:read`.
3. **Agents & AI Apps:** turn on access to Slack's MCP server. Without it, Settings says "App is not enabled for Slack MCP server access" and runs have no Slack.
4. **Event Subscriptions:** turn them on, and under **Subscribe to events on behalf of users** add `message.im`, `message.channels`, `message.groups`, `message.mpim`.
5. **Install the app while signed in to Slack as Arjun** (`arjun303`), so the token is his. The **User OAuth Token** (`xoxp-…`) is `SLACK_USER_TOKEN`. After changing scopes later, reinstall: the token usually stays the same and gains the new scopes.

Invite Arjun to the channels he should hear.

### 2. Create the app in Coolify

1. **New resource → Docker Compose**, repository `tr-ibe/arjun`, branch `main`. Coolify uses `docker-compose.yml`.
2. **Environment variables:**

   | Variable | Value |
   |---|---|
   | `AUTH_USERNAME`, `AUTH_PASSWORD` | The web UI login |
   | `SESSION_SECRET` | A long random string: `openssl rand -hex 32` |
   | `SLACK_USER_TOKEN` | `xoxp-…` from step 1 |
   | `SLACK_APP_TOKEN` | `xapp-…` from step 1 |
   | `SLACK_ALLOWED_USERS` | Optional. Slack user IDs who may talk to Arjun, comma-separated. Empty means every full member of the workspace. |
   | `OPENAI_API_KEY` | Optional. Passed through to runs. |

3. **Domain:** set one on the `arjun` service, port `3000`.
4. **Deploy.** Coolify doesn't deploy on a push to `main` (the app's source has no GitHub webhook), so press **Deploy** here and after every change.

### 3. Log in, in the container's terminal

Open the `arjun` service's **Terminal** in Coolify. It's already the `node` user. In this order:

1. **The main Claude account.** Run `claude`, then `/login` and sign in with the Claude subscription that should be tried first, then `/exit`.
2. **GitHub.** Run `gh auth login`: GitHub.com → HTTPS → log in with a web browser, signed in to GitHub as `arjun-mytribe` (it needs read access to `tr-ibe/mytribe`). Check with `gh auth status`.
3. **The mytribe plugin.** In the web UI, Settings → **From Arjun** → **Check now**. The mytribe plugin row should say **Up to date**. Arjun fetches it with the GitHub login from the step before.
4. **The mytribe CLI.** Run `mytribe login arjun@mytribe.in`. A sign-in code goes to the arjun@mytribe.in inbox. Then run `mytribe login --code <code>`. It prints the email and roles. (`mytribe` needs the plugin from the step before.)
5. **More Claude accounts**, if there are other subscriptions: see [Adding an account](#adding-an-account).

### 4. API keys

On the **API keys** page, create one key per caller (mytribe, trigger, agent0, …), and put each key in that caller's settings. Keys are only shown once.

### 5. Check everything

- **Settings → From Arjun:** the mytribe plugin is **Up to date**, the mytribe CLI is **Signed in** as arjun@mytribe.in, Slack is **Signed in** as arjun303. Press **Check now** after fixing anything.
- **Settings → Claude accounts:** every account is **Ready** with its 5-hour and week usage filled in.
- **The Coolify log** says `Slack is on, as …`.
- **DM Arjun in Slack** ("what's the date today?"). A task appears in the task list with the source **Slack**, and he replies in the thread as Arjun.
- **Create a task** in the web UI that uses the plugin, for example `/mytribe:providers kids birthday magician in Bengaluru`, and check it finishes.

## Claude accounts

Runs go to the first account in the list until it has used 85% of its 5-hour window (or 95% of its week), then to the next, and so on (the percentages are on the Settings page). An account only provides usage: plugins, Slack and the mytribe CLI come from Arjun, so there's nothing else to set up per account.

### Adding an account

In the container's terminal:

```bash
add-account second
```

Use any name (letters, digits, `-` and `_`; `main` is taken). Claude opens with the new account's folder, `~/accounts/second`. In it, `/login` with the new Claude subscription, then `/exit`. `add-account` checks that the login was saved.

The account appears at the bottom of Settings → Claude accounts within a minute, or straight away with **Check usage now**. Move it up or down with the arrows. A third, fourth or tenth account works the same way.

### Removing an account

1. Settings → Claude accounts → **Turn off** on its row, and wait until its **Running** count is 0.
2. In the container's terminal: `rm -rf ~/accounts/<name>`.
3. Press **Remove** on its row.

Its past runs keep their history; they just no longer show which account they ran on. The main account can't be removed (its folder holds every session): move it down the list or turn it off instead.

To stop using an account for a while without removing it, **Turn off** is enough. **Turn on** brings it back in the same place.

### Logging an account in again

When a row says **Needs login**: run `add-account <name>` (or `claude` for main), `/login`, `/exit`. Arjun notices the new login on its next check, or press **Try again** on the row.

### Putting a different subscription behind an account

To keep an account's name and place in the order but change the Claude subscription behind it:

1. **Turn off** the account, and wait until its **Running** count is 0. A run still using the old login can renew it and write it back over the new one.
2. In the container's terminal: `add-account <name>` (or `claude` for main), then `/logout`, `/login` with the other subscription, and `/exit`.
3. Press **Try again** if the row still shows the old subscription's **Limit reached** or **Needs login**, then **Turn on**.

## Keeping it running

- **Deploying:** press **Pause new runs**, wait until nothing is running, press **Deploy** in Coolify, then **Resume**. If you can't wait, deploy anyway: runs that were cut off continue by themselves after the restart. See [Deploying while tasks are running](README.md#deploying-while-tasks-are-running).
- **The mytribe plugin updates itself.** Arjun checks `tr-ibe/mytribe` `main` every 10 minutes and new runs use the latest copy, with no deploy. **Check now** on the Settings page fetches it straight away.
- **When something in From Arjun turns red:**
  - mytribe plugin: usually the GitHub login. Run `gh auth status`, and `gh auth login` again if needed. Runs keep the last copy meanwhile.
  - mytribe CLI: the sign-in ended. `mytribe login arjun@mytribe.in`, then `mytribe login --code <code>`.
  - Slack: the token was revoked or the app lost MCP access. Fix it in the Slack app (step 1), put a new token in Coolify if it changed, and redeploy.
