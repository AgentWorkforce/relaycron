import { Hono } from "hono";
import { cors } from "hono/cors";
import { createDbMiddleware } from "./middleware/db.js";
import authRouter from "./routes/auth.js";
import { createSchedulesRouter } from "./routes/schedules.js";
import executionsRouter from "./routes/executions.js";
import type { Database, Scheduler } from "./types.js";

export function createApp(db: Database, scheduler: Scheduler): Hono {
  const app = new Hono();

  app.use("*", cors());
  app.use("*", createDbMiddleware(db));

  // Health check
  app.get("/health", (c) =>
    c.json({ ok: true, data: { status: "healthy", version: "0.1.1" } })
  );

  // Routes
  app.route("/v1/auth", authRouter);
  app.route("/v1/schedules", createSchedulesRouter(scheduler));
  app.route("/v1", executionsRouter);

  // 404 handler
  app.notFound((c) =>
    c.json(
      { ok: false, error: { code: "not_found", message: "Route not found" } },
      404
    )
  );

  // Error handler
  app.onError((err, c) => {
    console.error("[app] unhandled error:", err);
    return c.json(
      {
        ok: false,
        error: { code: "internal_error", message: "Internal server error" },
      },
      500
    );
  });

  return app;
}

export type { Database, Scheduler } from "./types.js";
