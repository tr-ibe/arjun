import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ensureCleanupPeriod } from "./account_dir.js";
import { startAccountChecks } from "./accounts.js";
import { startAlerts } from "./alerts.js";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { db, now } from "./db.js";
import { kick, startDispatcher } from "./dispatcher.js";
import { recoverInterruptedRuns } from "./runner.js";
import { startSessionCleanup } from "./session_cleanup.js";
import { startSlack } from "./slack.js";
import { startToolChecks } from "./tools.js";

mkdirSync(config.runsDir, { recursive: true });
ensureCleanupPeriod(config.claudeConfigDir);
recoverInterruptedRuns();

const app = await buildApp();
await app.listen({ port: config.port, host: config.host });
// Runs start once Arjun has its plugins, so none goes out without them.
await startToolChecks(app.log);
startDispatcher();
startAccountChecks(app.log, kick);
startAlerts(app.log);
// A queued continue resumes the session in an earlier run's folder, so every folder of a task with a
// queued or running run is in use.
const runDirsInUse = db.prepare(`
  SELECT DISTINCT run_dir FROM runs
   WHERE run_dir IS NOT NULL
     AND task_id IN (SELECT task_id FROM runs WHERE status IN ('queued', 'running'))
`);
startSessionCleanup(app.log, {
  projectsDir: join(config.claudeConfigDir, "projects"),
  runsDir: config.runsDir,
  maxIdleMs: config.keepIdleRunsDays * 86_400_000,
  inUse: () => new Set((runDirsInUse.all() as { run_dir: string }[]).map((r) => r.run_dir)),
  beforeRemove: (runDir) =>
    db.prepare("UPDATE runs SET history_removed_at = ? WHERE run_dir = ? AND history_removed_at IS NULL").run(now(), runDir),
});
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
