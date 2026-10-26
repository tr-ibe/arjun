import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyError } from "fastify";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { authHook } from "./auth.js";
import { config } from "./config.js";
import { accountRoutes, authRoutes, keyRoutes, metaRoutes, settingsRoutes } from "./routes/admin.js";
import { internalRoutes } from "./routes/internal.js";
import { taskRoutes } from "./routes/tasks.js";
import { ValidationError } from "./settings.js";

export async function buildApp() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    // Off on purpose: the localhost check for /internal relies on the real socket address.
    trustProxy: false,
    bodyLimit: 1_000_000,
  });

  // Only JSON bodies. Plain-text bodies are one way other sites send cross-site requests.
  app.removeContentTypeParser("text/plain");

  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(rateLimit, { global: false });
  app.addHook("onRequest", authHook);

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof ValidationError) return reply.code(400).send({ error: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: "Something went wrong on the server. Check the server logs." });
  });

  app.get("/api/health", async () => ({ ok: true }));
  await app.register(authRoutes);
  await app.register(taskRoutes);
  await app.register(keyRoutes);
  await app.register(settingsRoutes);
  await app.register(accountRoutes);
  await app.register(metaRoutes);
  await app.register(internalRoutes);

  const hasUi = existsSync(join(config.webDir, "index.html"));
  if (hasUi) await app.register(fastifyStatic, { root: config.webDir, wildcard: false });

  // Any other GET is a page in the React app.
  app.setNotFoundHandler((req, reply) => {
    const isApi = req.url.startsWith("/api/") || req.url.startsWith("/internal/");
    if (!hasUi || isApi || req.method !== "GET") return reply.code(404).send({ error: "Not found." });
    return reply.sendFile("index.html");
  });

  return app;
}
