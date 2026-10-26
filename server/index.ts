import { mkdirSync } from "node:fs";
import { ensureCleanupPeriod } from "./account_dir.js";
import { startAccountChecks } from "./accounts.js";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { kick, startDispatcher } from "./dispatcher.js";
import { recoverInterruptedRuns } from "./runner.js";
import { startSlack } from "./slack.js";

mkdirSync(config.runsDir, { recursive: true });
ensureCleanupPeriod(config.claudeConfigDir);
recoverInterruptedRuns();

const app = await buildApp();
await app.listen({ port: config.port, host: config.host });
startDispatcher();
startAccountChecks(app.log, kick);
try {
  await startSlack(app.log);
} catch (err) {
  app.log.error(err, "Slack could not start; everything else keeps running");
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    app.log.info(`${signal} received, shutting down`);
    void app.close().finally(() => process.exit(0));
  });
}
