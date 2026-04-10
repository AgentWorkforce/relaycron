=== worker.ts ===
import { Hono } from "hono";
import { cors } from "hono/cors";
import { dbMiddleware } from "./middleware/db.js";
import authRouter from "./routes/auth.js";
import schedulesRouter from "./routes/schedules.js";
import executionsRouter from "./routes/executions.js";
import wsRouter from "./routes/ws.js";
import type { Env } from "./types.js";

export { SchedulerDO } from "./durable-objects/scheduler-do.js";

const app = new Hono<{ Bindings: Env }>();

// Global middleware
app.use("*", cors());
app.use("*", dbMiddleware);

// Health check
app.get("/health", (c) =>
  c.json({ ok: true, data: { status: "healthy", version: "0.1.0" } })
);

// Routes
app.route("/v1/auth", authRouter);
app.route("/v1/schedules", schedulesRouter);
app.route("/v1", executionsRouter);
app.route("/v1/ws", wsRouter);

// 404
app.notFound((c) =>
  c.json(
    { ok: false, error: { code: "not_found", message: "Not found" } },
    404
  )
);

// Error handler
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json(
    {
      ok: false,
      error: { code: "internal_error", message: "Internal server error" },
    },
    500
  );
});

export default {
  fetch: app.fetch,

  // Cron trigger as a fallback to catch any missed alarms
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    // The Durable Object alarms handle individual schedule execution.
    // This cron trigger serves as a sweep to catch edge cases where
    // a DO alarm might have been missed (e.g., after a deploy).
    // In a future version, this can scan for overdue schedules and re-arm them.
    console.log("Cron sweep triggered");
  },
};
=== types.ts ===
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "./db/schema.js";

export interface Env {
  DB: D1Database;
  SCHEDULER_DO: DurableObjectNamespace;
  ENVIRONMENT: string;
}

export type Database = DrizzleD1Database<typeof schema>;

export interface AuthContext {
  apiKeyId: string;
}

// Extend Hono context
declare module "hono" {
  interface ContextVariableMap {
    db: Database;
    auth: AuthContext;
  }
}
=== middleware/db.ts ===
import { createMiddleware } from "hono/factory";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema.js";
import type { Env } from "../types.js";

export const dbMiddleware = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const db = drizzle(c.env.DB, { schema });
    c.set("db", db);
    await next();
  }
);
=== middleware/auth.ts ===
import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import { apiKeys } from "../db/schema.js";
import type { Env } from "../types.js";

async function hashKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const requireAuth = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json(
        {
          ok: false,
          error: {
            code: "unauthorized",
            message: "Missing or invalid Authorization header",
          },
        },
        401
      );
    }

    const token = authHeader.slice(7);
    if (!token.startsWith("ac_")) {
      return c.json(
        {
          ok: false,
          error: { code: "unauthorized", message: "Invalid API key format" },
        },
        401
      );
    }

    const keyHash = await hashKey(token);
    const db = c.get("db");
    const [key] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.key_hash, keyHash))
      .limit(1);

    if (!key) {
      return c.json(
        {
          ok: false,
          error: { code: "unauthorized", message: "Invalid API key" },
        },
        401
      );
    }

    // Update last_used_at (fire and forget)
    c.executionCtx.waitUntil(
      db
        .update(apiKeys)
        .set({ last_used_at: new Date().toISOString() })
        .where(eq(apiKeys.id, key.id))
    );

    c.set("auth", { apiKeyId: key.id });
    await next();
  }
);

export { hashKey };
