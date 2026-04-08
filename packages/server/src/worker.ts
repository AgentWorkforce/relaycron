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
