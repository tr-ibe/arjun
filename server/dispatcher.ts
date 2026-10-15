import { db, now, type RunRow } from "./db.js";
import { activeCount, setOnRunEnded, startRun } from "./runner.js";
import { getSettings } from "./settings.js";

// Highest priority first (1 is highest), then oldest. A continue waits until the attempt
// before it has finished, since both use the same Claude session.
const nextRun = db.prepare(`
  SELECT r.*
    FROM runs r
    JOIN tasks t ON t.id = r.task_id
    LEFT JOIN runs prev ON prev.id = r.resumed_from_run_id
   WHERE r.status = 'queued'
     AND (r.resumed_from_run_id IS NULL OR prev.ended_at IS NOT NULL)
   ORDER BY t.priority ASC, r.created_at ASC, r.id ASC
   LIMIT 1
`);

const queuedInOrder = db.prepare(`
  SELECT r.id
    FROM runs r
    JOIN tasks t ON t.id = r.task_id
   WHERE r.status = 'queued'
   ORDER BY t.priority ASC, r.created_at ASC, r.id ASC
`);

export function pausedUntil(): string | null {
  const row = db
    .prepare("SELECT MAX(resets_at) AS t FROM runs WHERE status = 'limited' AND resets_at > ?")
    .get(now()) as { t: string | null };
  return row.t;
}

// Place in line for each queued run, 1 = next to start.
export function queuePositions(): Map<number, number> {
  const ids = (queuedInOrder.all() as { id: number }[]).map((r) => r.id);
  return new Map(ids.map((id, i) => [id, i + 1]));
}

let busy = false;
let again = false;

// Starts as many queued runs as the limits allow. Safe to call any time; calls made while
// it's already working just make it go round once more.
export function kick(): void {
  if (busy) {
    again = true;
    return;
  }
  busy = true;
  try {
    do {
      again = false;
      fill();
    } while (again);
  } finally {
    busy = false;
  }
}

function fill() {
  const { max_concurrency } = getSettings();
  while (activeCount() < max_concurrency && !pausedUntil()) {
    const run = nextRun.get() as RunRow | undefined;
    if (!run) return;
    try {
      startRun(run);
    } catch (err) {
      db.prepare("UPDATE runs SET status = 'error', error = ?, ended_at = ? WHERE id = ?").run(
        `Could not start the run: ${(err as Error).message}`,
        now(),
        run.id,
      );
    }
  }
}

export function startDispatcher(): void {
  setOnRunEnded(() => setImmediate(kick));
  setInterval(kick, 3_000).unref();
  kick();
}
