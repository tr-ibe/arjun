import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { db, now, type ApiKeyRow } from "./db.js";

export type Caller = { kind: "ui" } | { kind: "api"; keyId: number; keyName: string };

declare module "fastify" {
  interface FastifyRequest {
    caller?: Caller;
  }
}

const COOKIE = "sid";
const SESSION_DAYS = 14;

const sha256 = (s: string) => createHash("sha256").update(s).digest();

export function checkLogin(username: string, password: string): boolean {
  // Compare hashes so the comparison takes the same time whatever the input.
  const userOk = timingSafeEqual(sha256(username), sha256(config.authUsername));
  const passOk = timingSafeEqual(sha256(password), sha256(config.authPassword));
  return userOk && passOk;
}

function isHttps(req: FastifyRequest): boolean {
  return req.headers["x-forwarded-proto"] === "https" || req.protocol === "https";
}

export function setSessionCookie(req: FastifyRequest, reply: FastifyReply): void {
  const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  reply.setCookie(COOKIE, JSON.stringify({ exp: expires }), {
    signed: true,
    httpOnly: true,
    sameSite: "lax",
    secure: isHttps(req),
    path: "/",
    expires: new Date(expires),
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(COOKIE, { path: "/" });
}

function hasValidSession(req: FastifyRequest): boolean {
  const raw = req.cookies[COOKIE];
  if (!raw) return false;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return false;
  try {
    const { exp } = JSON.parse(unsigned.value) as { exp: number };
    return typeof exp === "number" && exp > Date.now();
  } catch {
    return false;
  }
}

// ---- API keys ----

const hashKey = (key: string) => sha256(key).toString("hex");

export function createApiKey(name: string): { key: string; row: ApiKeyRow } {
  const key = `ak_${randomBytes(24).toString("base64url")}`;
  const info = db
    .prepare("INSERT INTO api_keys (name, key_prefix, key_hash, created_at) VALUES (?, ?, ?, ?)")
    .run(name, key.slice(0, 10), hashKey(key), now());
  const row = db.prepare("SELECT * FROM api_keys WHERE id = ?").get(info.lastInsertRowid) as ApiKeyRow;
  return { key, row };
}

export function listApiKeys(): Omit<ApiKeyRow, "key_hash">[] {
  return db
    .prepare("SELECT id, name, key_prefix, created_at, last_used_at, revoked_at FROM api_keys ORDER BY id DESC")
    .all() as Omit<ApiKeyRow, "key_hash">[];
}

export function revokeApiKey(id: number): boolean {
  return db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now(), id).changes > 0;
}

function callerFromApiKey(req: FastifyRequest): Caller | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const row = db
    .prepare("SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL")
    .get(hashKey(header.slice(7).trim())) as ApiKeyRow | undefined;
  if (!row) return null;
  // Record use at most once a minute to avoid a write on every request.
  if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > 60_000) {
    db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now(), row.id);
  }
  return { kind: "api", keyId: row.id, keyName: row.name };
}

// ---- The one check every request goes through ----

const OPEN = new Set(["/api/auth/login", "/api/health"]);
const SESSION_ONLY = ["/api/keys", "/api/settings", "/api/accounts", "/api/queue", "/api/tools", "/api/auth/"];
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export async function authHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const path = req.url.split("?")[0];

  if (path.startsWith("/internal/")) {
    // trustProxy is off, so this is the real socket address and can't be spoofed with headers.
    if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) {
      return reply.code(403).send({ error: "Only reachable from inside the container." });
    }
    return;
  }

  if (!path.startsWith("/api/") || OPEN.has(path)) return;

  const caller: Caller | null = hasValidSession(req) ? { kind: "ui" } : callerFromApiKey(req);
  if (!caller) {
    return reply.code(401).send({ error: "Log in, or send a valid API key as 'Authorization: Bearer <key>'." });
  }

  if (caller.kind === "api" && SESSION_ONLY.some((p) => path.startsWith(p))) {
    return reply.code(403).send({ error: "API keys can't manage keys, settings, accounts, tools or the queue. Log in to the web UI." });
  }

  // Browser requests that change something must be JSON. Other sites can't send that cross-site
  // without a CORS preflight, which this server never allows.
  if (caller.kind === "ui" && req.method !== "GET" && !String(req.headers["content-type"] ?? "").includes("application/json")) {
    return reply.code(415).send({ error: "Send requests as application/json." });
  }

  req.caller = caller;
}
