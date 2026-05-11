import { Hono } from "hono";
import { eq, and, desc, lt } from "drizzle-orm";
import {
  UpdateScheduleRequest,
  ListSchedulesQuery,
} from "@relaycron/types";
import { schedules } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { getNextCronDate, isValidCron } from "../engine/cron.js";
import type { Database, Scheduler } from "../types.js";
import {
  cancelScheduleRecord,
  computeNextRunAt,
  createScheduleRecord,
  formatSchedule,
  parseScheduleRequest,
} from "../lib/schedules.js";

export function createSchedulesRouter(scheduler: Scheduler) {
  const schedulesRouter = new Hono();

  schedulesRouter.use("*", requireAuth);

  const handleCancelRequest = async (
    db: Database,
    apiKeyId: string,
    scheduleId: string
  ) => {
    const existing = await cancelScheduleRecord(db, scheduler, apiKeyId, scheduleId);

    if (!existing) {
      return {
        ok: false as const,
        response: {
          ok: false as const,
          error: { code: "not_found", message: "Schedule not found" },
        },
      };
    }

    return {
      ok: true as const,
      response: {
        ok: true as const,
        data: { cancelled: true, schedule_id: scheduleId },
      },
    };
  };

  // Create schedule
  schedulesRouter.post("/", async (c) => {
    const raw = await c.req.json();
    const parsed = parseScheduleRequest(raw);
    if (!parsed.ok) {
      return c.json(
        {
          ok: false,
          error: {
            code: parsed.error.code,
            message: parsed.error.message,
          },
        },
        400
      );
    }

    const auth = c.get("auth");
    const db = c.get("db");
    const record = await createScheduleRecord(
      db,
      scheduler,
      auth.apiKeyId,
      parsed.data
    );

    return c.json(
      {
        ok: true,
        data: formatSchedule(record),
      },
      201
    );
  });

  // List schedules
  schedulesRouter.get("/", async (c) => {
    const queryParams: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.req.query())) {
      if (typeof v === "string") queryParams[k] = v;
    }
    const query = ListSchedulesQuery.parse(queryParams);
    const auth = c.get("auth");
    const db = c.get("db");

    const conditions = [eq(schedules.api_key_id, auth.apiKeyId)];
    if (query.status) conditions.push(eq(schedules.status, query.status));
    if (query.schedule_type)
      conditions.push(eq(schedules.schedule_type, query.schedule_type));
    if (query.cursor) conditions.push(lt(schedules.created_at, query.cursor));

    const results = await db
      .select()
      .from(schedules)
      .where(and(...conditions))
      .orderBy(desc(schedules.created_at))
      .limit(query.limit + 1);

    const hasMore = results.length > query.limit;
    const items = hasMore ? results.slice(0, query.limit) : results;

    return c.json({
      ok: true,
      data: items.map(formatSchedule),
      cursor: hasMore ? items[items.length - 1].created_at : null,
      has_more: hasMore,
    });
  });

  // Get schedule
  schedulesRouter.get("/:id", async (c) => {
    const auth = c.get("auth");
    const db = c.get("db");

    const [schedule] = await db
      .select()
      .from(schedules)
      .where(
        and(
          eq(schedules.id, c.req.param("id")),
          eq(schedules.api_key_id, auth.apiKeyId)
        )
      )
      .limit(1);

    if (!schedule) {
      return c.json(
        {
          ok: false,
          error: { code: "not_found", message: "Schedule not found" },
        },
        404
      );
    }

    return c.json({ ok: true, data: formatSchedule(schedule) });
  });

  // Update schedule
  schedulesRouter.patch("/:id", async (c) => {
    const auth = c.get("auth");
    const db = c.get("db");

    const [existing] = await db
      .select()
      .from(schedules)
      .where(
        and(
          eq(schedules.id, c.req.param("id")),
          eq(schedules.api_key_id, auth.apiKeyId)
        )
      )
      .limit(1);

    if (!existing) {
      return c.json(
        {
          ok: false,
          error: { code: "not_found", message: "Schedule not found" },
        },
        404
      );
    }

    const raw = await c.req.json();
    const parsed = UpdateScheduleRequest.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          ok: false,
          error: {
            code: "validation_error",
            message: parsed.error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; "),
          },
        },
        400
      );
    }

    const data = parsed.data;
    const now = new Date().toISOString();

    const updates: Record<string, unknown> = { updated_at: now };
    if (data.name !== undefined) updates.name = data.name;
    if (data.description !== undefined) updates.description = data.description;
    if (data.payload !== undefined) updates.payload = JSON.stringify(data.payload);
    if (data.status !== undefined) updates.status = data.status;
    if (data.timezone !== undefined) updates.timezone = data.timezone;
    if (data.metadata !== undefined)
      updates.metadata = JSON.stringify(data.metadata);

    if (data.transport !== undefined) {
      updates.transport_type = data.transport.type;
      updates.transport_config = JSON.stringify(data.transport);
    }

    if (data.cron_expression !== undefined) {
      if (!isValidCron(data.cron_expression)) {
        return c.json(
          {
            ok: false,
            error: {
              code: "validation_error",
              message: "Invalid cron expression",
            },
          },
          400
        );
      }
      updates.cron_expression = data.cron_expression;
      const tz = (data.timezone ?? existing.timezone) as string;
      const next = getNextCronDate(data.cron_expression, tz);
      updates.next_run_at = next ? next.toISOString() : null;
    }

    if (data.scheduled_at !== undefined) {
      updates.scheduled_at = data.scheduled_at;
      updates.next_run_at = data.scheduled_at;
    }

    // Pause/resume semantics must update next_run_at before the DB write.
    // - pause: cancel any pending alarm
    // - resume: recompute and re-arm next run if possible
    if (data.status === "paused") {
      updates.next_run_at = null;
    } else if (data.status === "active" && existing.status !== "active") {
      updates.next_run_at = computeNextRunAt(
        existing.schedule_type,
        (updates.cron_expression as string | undefined) ?? existing.cron_expression,
        (updates.scheduled_at as string | undefined) ?? existing.scheduled_at,
        (updates.timezone as string | undefined) ?? existing.timezone
      );
    }

    await db
      .update(schedules)
      .set(updates)
      .where(eq(schedules.id, c.req.param("id")));

    // Update alarm if next_run_at changed or status toggled.
    if (updates.next_run_at !== undefined || data.status !== undefined) {
      const effectiveNextRunAt =
        updates.next_run_at !== undefined ? updates.next_run_at : existing.next_run_at;
      if (effectiveNextRunAt) {
        scheduler.setAlarm(c.req.param("id"), effectiveNextRunAt as string);
      } else {
        scheduler.cancelAlarm(c.req.param("id"));
      }
    }

    // Re-fetch
    const [updated] = await db
      .select()
      .from(schedules)
      .where(eq(schedules.id, c.req.param("id")))
      .limit(1);

    return c.json({ ok: true, data: formatSchedule(updated) });
  });

  // Delete schedule
  schedulesRouter.delete("/:id", async (c) => {
    const auth = c.get("auth");
    const db = c.get("db");
    const result = await handleCancelRequest(db, auth.apiKeyId, c.req.param("id"));

    return c.json(result.response, result.ok ? 200 : 404);
  });

  // Explicit cancel-by-id endpoint for control planes that want a non-destructive verb.
  schedulesRouter.post("/:id/cancel", async (c) => {
    const auth = c.get("auth");
    const db = c.get("db");
    const result = await handleCancelRequest(db, auth.apiKeyId, c.req.param("id"));

    return c.json(result.response, result.ok ? 200 : 404);
  });

  return schedulesRouter;
}
