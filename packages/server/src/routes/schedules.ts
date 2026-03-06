import { Hono } from "hono";
import { eq, and, desc, lt } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  CreateScheduleRequest,
  UpdateScheduleRequest,
  ListSchedulesQuery,
} from "@agentcron/types";
import { schedules } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { getNextCronDate, isValidCron } from "../engine/cron.js";
import type { Env } from "../types.js";

const schedulesRouter = new Hono<{ Bindings: Env }>();

schedulesRouter.use("*", requireAuth);

// Create schedule
schedulesRouter.post("/", async (c) => {
  const raw = await c.req.json();
  const parsed = CreateScheduleRequest.safeParse(raw);
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

  // Validate cron expression
  if (data.schedule_type === "cron") {
    if (!data.cron_expression) {
      return c.json(
        {
          ok: false,
          error: {
            code: "validation_error",
            message: "cron_expression is required for cron schedules",
          },
        },
        400
      );
    }
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
  }

  if (data.schedule_type === "once" && !data.scheduled_at) {
    return c.json(
      {
        ok: false,
        error: {
          code: "validation_error",
          message: "scheduled_at is required for one-time schedules",
        },
      },
      400
    );
  }

  // Calculate next run
  let nextRunAt: string | null = null;
  if (data.schedule_type === "cron" && data.cron_expression) {
    const next = getNextCronDate(data.cron_expression, data.timezone);
    nextRunAt = next ? next.toISOString() : null;
  } else if (data.schedule_type === "once" && data.scheduled_at) {
    nextRunAt = data.scheduled_at;
  }

  const id = nanoid();
  const now = new Date().toISOString();
  const auth = c.get("auth");

  const transportConfig = { ...data.transport };

  const record = {
    id,
    api_key_id: auth.apiKeyId,
    name: data.name,
    description: data.description ?? null,
    schedule_type: data.schedule_type,
    cron_expression: data.cron_expression ?? null,
    scheduled_at: data.scheduled_at ?? null,
    timezone: data.timezone,
    payload: JSON.stringify(data.payload),
    transport_type: data.transport.type,
    transport_config: JSON.stringify(transportConfig),
    status: "active" as const,
    next_run_at: nextRunAt,
    last_run_at: null,
    run_count: 0,
    failure_count: 0,
    metadata: data.metadata ? JSON.stringify(data.metadata) : null,
    created_at: now,
    updated_at: now,
  };

  const db = c.get("db");
  await db.insert(schedules).values(record);

  // Set alarm on the Durable Object
  if (nextRunAt) {
    const doId = c.env.SCHEDULER_DO.idFromName(id);
    const stub = c.env.SCHEDULER_DO.get(doId);
    await stub.fetch("http://internal/set-alarm", {
      method: "POST",
      body: JSON.stringify({ schedule_id: id, run_at: nextRunAt }),
    });
  }

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

  await db
    .update(schedules)
    .set(updates)
    .where(eq(schedules.id, c.req.param("id")));

  // Update alarm if next_run_at changed
  if (updates.next_run_at !== undefined) {
    const doId = c.env.SCHEDULER_DO.idFromName(c.req.param("id"));
    const stub = c.env.SCHEDULER_DO.get(doId);
    if (updates.next_run_at) {
      await stub.fetch("http://internal/set-alarm", {
        method: "POST",
        body: JSON.stringify({
          schedule_id: c.req.param("id"),
          run_at: updates.next_run_at,
        }),
      });
    } else {
      await stub.fetch("http://internal/cancel-alarm", { method: "POST" });
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

  // Cancel alarm
  const doId = c.env.SCHEDULER_DO.idFromName(c.req.param("id"));
  const stub = c.env.SCHEDULER_DO.get(doId);
  await stub.fetch("http://internal/cancel-alarm", { method: "POST" });

  await db.delete(schedules).where(eq(schedules.id, c.req.param("id")));

  return c.json({ ok: true, data: { deleted: true } });
});

function formatSchedule(row: typeof schedules.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    schedule_type: row.schedule_type,
    cron_expression: row.cron_expression,
    scheduled_at: row.scheduled_at,
    timezone: row.timezone,
    payload: JSON.parse(row.payload),
    transport_type: row.transport_type,
    transport_config: JSON.parse(row.transport_config),
    status: row.status,
    next_run_at: row.next_run_at,
    last_run_at: row.last_run_at,
    run_count: row.run_count,
    failure_count: row.failure_count,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export default schedulesRouter;
