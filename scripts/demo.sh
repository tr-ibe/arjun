#!/bin/sh
# Runs the built server locally with the fake Claude, so the UI can be tried without using the Max plan.
# Login: admin / demo. Data goes to .demo/ (git-ignored).
set -e
cd "$(dirname "$0")/.."
mkdir -p .demo
export PORT="${PORT:-3000}"
export AUTH_USERNAME=admin
export AUTH_PASSWORD=demo
export SESSION_SECRET=demo-secret-demo-secret-demo-secret
export DATA_DIR="$PWD/.demo/data"
export RUNS_DIR="$PWD/.demo/runs"
export CLAUDE_CONFIG_DIR="$PWD/.demo/claude"
export ACCOUNTS_DIR="$PWD/.demo/accounts"
export PLUGINS_DIR="$PWD/.demo/plugins"
export CLAUDE_BIN="$PWD/scripts/fake-claude.mjs"
export APP_ROOT="$PWD"
exec node dist/server/index.js
