# ---- Build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 usually downloads a prebuilt binary; these are the fallback for compiling it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci
COPY web/package.json web/package-lock.json web/
RUN npm --prefix web ci

COPY tsconfig.json ./
COPY server server
COPY cli cli
COPY web web
RUN npm run build && npm prune --omit=dev


# ---- Runtime ----
FROM node:22-bookworm-slim

# Tools an agent commonly needs, plus tini to reap the processes Claude starts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git gnupg jq less openssh-client procps python3 ripgrep tini unzip \
 && mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

# Chromium for Playwright, with the system libraries it needs (only root can install those).
# Installed globally so skills can use it (mytribe's shortlist screenshots look for it there).
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN npm install -g playwright@1.55.0 \
 && playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY --from=build /app/web/dist web/dist
COPY bin bin

ENV NODE_ENV=production \
    PORT=3000 \
    APP_ROOT=/app \
    PATH=/app/bin:$PATH \
    DISABLE_AUTOUPDATER=1

# Claude refuses to skip permissions as root, so everything runs as the image's normal user.
# Its home folder (/home/node) is the one volume: Claude's login and history, the database, run folders.
USER node
WORKDIR /home/node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/dist/server/index.js"]
