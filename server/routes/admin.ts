import type { FastifyInstance } from "fastify";
import {
  accountViews,
  checkAllAccounts,
  forgetAccount,
  moveAccount,
  resetAccount,
  setAccountEnabled,
} from "../accounts.js";
import { checkLogin, clearSessionCookie, createApiKey, listApiKeys, revokeApiKey, setSessionCookie } from "../auth.js";
import { kick } from "../dispatcher.js";
import { checkTools, toolViews } from "../tools.js";
import { EFFORTS, getSettings, MODELS, updateSettings, ValidationError } from "../settings.js";

// The proxy in front (Coolify) appends the real client address last, so rate-limit on that.
function clientAddress(req: { headers: Record<string, string | string[] | undefined>; ip: string }): string {
  const forwarded = req.headers["x-forwarded-for"];
  const list = (Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? "")).split(",").map((s) => s.trim());
  return list.filter(Boolean).pop() ?? req.ip;
}

export async function authRoutes(app: FastifyInstance) {
  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes", keyGenerator: clientAddress } } },
    async (req, reply) => {
      const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
      if (typeof username !== "string" || typeof password !== "string" || !checkLogin(username, password)) {
        return reply.code(401).send({ error: "Wrong username or password." });
      }
      setSessionCookie(req, reply);
      return { ok: true };
    },
  );

  app.post("/api/auth/logout", async (_req, reply) => {
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get("/api/auth/me", async () => ({ ok: true }));
}

export async function keyRoutes(app: FastifyInstance) {
  app.get("/api/keys", async () => listApiKeys());

  app.post("/api/keys", async (req, reply) => {
    const { name } = (req.body ?? {}) as { name?: unknown };
    if (typeof name !== "string" || !name.trim() || name.length > 100) {
      throw new ValidationError("Give the key a name, e.g. mytribe, trigger or agent0.");
    }
    const { key, row } = createApiKey(name.trim());
    const { key_hash: _hash, ...visible } = row;
    return reply.code(201).send({ ...visible, key });
  });

  app.post("/api/keys/:id/revoke", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!revokeApiKey(id)) return reply.code(404).send({ error: "Key not found or already revoked." });
    return { ok: true };
  });
}

export async function settingsRoutes(app: FastifyInstance) {
  app.get("/api/settings", async () => ({ settings: getSettings(), models: MODELS, efforts: EFFORTS }));

  app.patch("/api/settings", async (req) => {
    const settings = updateSettings((req.body ?? {}) as Record<string, unknown>);
    kick(); // a higher limit can start queued runs right away
    return { settings, models: MODELS, efforts: EFFORTS };
  });
}

// Form options and defaults, available to API keys too.
export async function metaRoutes(app: FastifyInstance) {
  app.get("/api/meta", async () => {
    const s = getSettings();
    return {
      models: MODELS,
      efforts: EFFORTS,
      defaults: {
        model: s.default_model,
        effort: s.default_effort,
        priority: s.default_priority,
        timeout_min: s.default_timeout_min,
      },
    };
  });
}

// The Claude accounts runs go to, in order. They're added with the add-account command in the container.
export async function accountRoutes(app: FastifyInstance) {
  const id = (req: { params: unknown }) => Number((req.params as { id: string }).id);

  app.get("/api/accounts", async () => accountViews());

  // Looks for new account folders and reads every account's usage now.
  app.post("/api/accounts/check", async () => {
    await checkAllAccounts({ force: true });
    kick();
    return accountViews();
  });

  app.post("/api/accounts/:id/move", async (req) => {
    const { direction } = (req.body ?? {}) as { direction?: unknown };
    if (direction !== "up" && direction !== "down") throw new ValidationError("direction must be up or down.");
    moveAccount(id(req), direction);
    kick();
    return accountViews();
  });

  app.patch("/api/accounts/:id", async (req) => {
    const { enabled } = (req.body ?? {}) as { enabled?: unknown };
    if (typeof enabled !== "boolean") throw new ValidationError("enabled must be true or false.");
    setAccountEnabled(id(req), enabled);
    kick();
    return accountViews();
  });

  // Clears a login problem or a limit, so the account is tried again.
  app.post("/api/accounts/:id/reset", async (req) => {
    resetAccount(id(req));
    kick();
    return accountViews();
  });

  app.post("/api/accounts/:id/forget", async (req) => {
    forgetAccount(id(req));
    return accountViews();
  });
}

// What Arjun gives every run itself, whichever Claude account it's on.
export async function toolRoutes(app: FastifyInstance) {
  app.get("/api/tools", async () => toolViews());

  // Updates the plugins and checks the sign-ins now.
  app.post("/api/tools/check", async () => {
    await checkTools();
    return toolViews();
  });
}
