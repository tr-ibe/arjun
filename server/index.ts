import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { startDispatcher } from "./dispatcher.js";
import { recoverInterruptedRuns } from "./runner.js";

// Run history lives in Claude's session files, which Claude Code deletes after 30 days by default.
// Keep them for 60 unless someone already chose a value.
function ensureClaudeSettings() {
  const file = join(config.claudeConfigDir, "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return; // Don't overwrite a file we can't read.
    }
  }
  if (settings.cleanupPeriodDays !== undefined) return;
  settings.cleanupPeriodDays = 60;
  mkdirSync(config.claudeConfigDir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

mkdirSync(config.runsDir, { recursive: true });
ensureClaudeSettings();
recoverInterruptedRuns();

const app = await buildApp();
await app.listen({ port: config.port, host: config.host });
startDispatcher();

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    app.log.info(`${signal} received, shutting down`);
    void app.close().finally(() => process.exit(0));
  });
}
