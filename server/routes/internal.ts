import type { FastifyInstance } from "fastify";
import { getRun, updateRun } from "../db.js";
import { isActive } from "../runner.js";

const REPORTABLE = ["done", "stuck", "error"] as const;

// Called by the update_run command from inside a run. The auth hook only lets localhost in.
export async function internalRoutes(app: FastifyInstance) {
  app.post("/internal/runs/:id/report", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const { status, summary } = (req.body ?? {}) as { status?: string; summary?: string };

    if (!REPORTABLE.includes(status as (typeof REPORTABLE)[number])) {
      return reply.code(400).send({ error: "status must be done, stuck or error." });
    }
    if (typeof summary !== "string" || !summary.trim()) {
      return reply.code(400).send({ error: "A summary is required." });
    }

    const run = getRun(id);
    if (!run) return reply.code(404).send({ error: `Run ${id} not found.` });
    // While the process is alive Claude may correct an earlier report, but not undo a cancel or timeout.
    if (!isActive(id) || run.status === "cancelled") {
      return reply.code(409).send({ error: `Run ${id} is not running (status: ${run.status}).` });
    }

    updateRun(id, {
      status: status as (typeof REPORTABLE)[number],
      summary: summary.trim().slice(0, 20_000),
      error: status === "error" ? summary.trim().slice(0, 20_000) : null,
    });
    return { ok: true };
  });
}
