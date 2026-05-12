import { nanoid } from "nanoid";
import { and, eq } from "drizzle-orm";
import {
  CreateScheduleRequest,
  RegisterScheduleRequest,
} from "@relaycron/types";
import { getNextCronDate, isValidCron } from "../engine/cron.js";
import { schedules } from "../db/schema.js";
import type { Database, Scheduler } from "../types.js";

type NormalizedTransport =
  | {
      type: "webhook";
      url: string;
      headers?: Record<string, string>;
      timeout_ms: number;
    }
  | {
      type: "websocket";
      channel?: string;
      coalesce_missed_ticks: "none" | "fire-once";
    };

export interface NormalizedScheduleRequest {
  name: string;
  description?: string;
  schedule_type: "once" | "cron";
  cron_expression?: string;
  scheduled_at?: string;
  timezone: string;
  payload: unknown;
  transport: NormalizedTransport;
  metadata?: Record<string, unknown>;
}

export interface ValidationError {
  code: string;
  message: string;
}

export function parseScheduleRequest(
  raw: unknown
): { ok: true; data: NormalizedScheduleRequest } | { ok: false; error: ValidationError } {
  const modern = RegisterScheduleRequest.safeParse(raw);
  if (modern.success) {
    return normalizeRegisterRequest(modern.data);
  }

  const legacy = CreateScheduleRequest.safeParse(raw);
  if (legacy.success) {
    return normalizeLegacyRequest(legacy.data);
  }

  const message = modern.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");

  return {
    ok: false,
    error: {
      code: "validation_error",
      message,
    },
  };
}

function normalizeLegacyRequest(
  data: CreateScheduleRequest
): { ok: true; data: NormalizedScheduleRequest } | { ok: false; error: ValidationError } {
  if (data.schedule_type === "cron") {
    if (!data.cron_expression) {
      return {
        ok: false,
        error: {
          code: "validation_error",
          message: "cron_expression is required for cron schedules",
        },
      };
    }

    if (!isValidCron(data.cron_expression)) {
      return {
        ok: false,
        error: {
          code: "validation_error",
          message: "Invalid cron expression",
        },
      };
    }
  }

  if (data.schedule_type === "once" && !data.scheduled_at) {
    return {
      ok: false,
      error: {
        code: "validation_error",
        message: "scheduled_at is required for one-time schedules",
      },
    };
  }

  return {
    ok: true,
    data: {
      name: data.name,
      description: data.description,
      schedule_type: data.schedule_type,
      cron_expression: data.cron_expression,
      scheduled_at: data.scheduled_at,
      timezone: data.timezone,
      payload: data.payload,
      transport:
        data.transport.type === "webhook"
          ? {
              type: "webhook",
              url: data.transport.url,
              headers: data.transport.headers,
              timeout_ms: data.transport.timeout_ms,
            }
          : {
              type: "websocket",
              channel: data.transport.channel,
              coalesce_missed_ticks: data.transport.coalesce_missed_ticks,
            },
      metadata: data.metadata,
    },
  };
}

function normalizeRegisterRequest(
  data: RegisterScheduleRequest
): { ok: true; data: NormalizedScheduleRequest } | { ok: false; error: ValidationError } {
  const scheduleSpec = data.schedule;

  if (typeof scheduleSpec === "string") {
    const scheduledAt = new Date(scheduleSpec);
    if (!Number.isNaN(scheduledAt.getTime())) {
      return {
        ok: true,
        data: {
          name: data.name,
          description: data.description,
          schedule_type: "once",
          scheduled_at: scheduledAt.toISOString(),
          timezone: "UTC",
          payload: data.payload ?? {},
          transport: data.delivery,
          metadata: data.metadata,
        },
      };
    }

    if (!isValidCron(scheduleSpec)) {
      return {
        ok: false,
        error: {
          code: "validation_error",
          message: "Invalid schedule string. Expected cron expression or ISO timestamp.",
        },
      };
    }

    return {
      ok: true,
      data: {
        name: data.name,
        description: data.description,
        schedule_type: "cron",
        cron_expression: scheduleSpec,
        timezone: "UTC",
        payload: data.payload ?? {},
        transport: data.delivery,
        metadata: data.metadata,
      },
    };
  }

  if ("cron" in scheduleSpec) {
    if (!isValidCron(scheduleSpec.cron)) {
      return {
        ok: false,
        error: {
          code: "validation_error",
          message: "Invalid cron expression",
        },
      };
    }

    return {
      ok: true,
      data: {
        name: data.name,
        description: data.description,
        schedule_type: "cron",
        cron_expression: scheduleSpec.cron,
        timezone: scheduleSpec.tz ?? "UTC",
        payload: data.payload ?? {},
        transport: data.delivery,
        metadata: data.metadata,
      },
    };
  }

  return {
    ok: true,
    data: {
      name: data.name,
      description: data.description,
      schedule_type: "once",
      scheduled_at: scheduleSpec.at,
      timezone: "UTC",
      payload: data.payload ?? {},
      transport: data.delivery,
      metadata: data.metadata,
    },
  };
}

export function computeNextRunAt(
  scheduleType: "once" | "cron",
  cronExpression: string | null | undefined,
  scheduledAt: string | null | undefined,
  timezone: string
): string | null {
  if (scheduleType === "cron" && cronExpression) {
    const next = getNextCronDate(cronExpression, timezone);
    return next ? next.toISOString() : null;
  }

  if (scheduleType === "once" && scheduledAt) {
    return new Date(scheduledAt).getTime() > Date.now() ? scheduledAt : null;
  }

  return null;
}

export async function createScheduleRecord(
  db: Database,
  scheduler: Scheduler,
  apiKeyId: string,
  request: NormalizedScheduleRequest
) {
  const id = nanoid();
  const now = new Date().toISOString();
  const nextRunAt =
    request.schedule_type === "cron"
      ? computeNextRunAt(
          request.schedule_type,
          request.cron_expression,
          request.scheduled_at,
          request.timezone
        )
      : request.scheduled_at ?? null;

  const record = {
    id,
    api_key_id: apiKeyId,
    name: request.name,
    description: request.description ?? null,
    schedule_type: request.schedule_type,
    cron_expression: request.cron_expression ?? null,
    scheduled_at: request.scheduled_at ?? null,
    timezone: request.timezone,
    payload: JSON.stringify(request.payload),
    transport_type: request.transport.type,
    transport_config: JSON.stringify(request.transport),
    status: "active" as const,
    next_run_at: nextRunAt,
    last_run_at: null,
    run_count: 0,
    failure_count: 0,
    metadata: request.metadata ? JSON.stringify(request.metadata) : null,
    created_at: now,
    updated_at: now,
  };

  await db.insert(schedules).values(record);
  if (nextRunAt) {
    scheduler.setAlarm(id, nextRunAt);
  }

  return record;
}

export async function cancelScheduleRecord(
  db: Database,
  scheduler: Scheduler,
  apiKeyId: string,
  scheduleId: string
) {
  const [existing] = await db
    .select()
    .from(schedules)
    .where(and(eq(schedules.id, scheduleId), eq(schedules.api_key_id, apiKeyId)))
    .limit(1);

  if (!existing) {
    return null;
  }

  scheduler.cancelAlarm(scheduleId);
  await db.delete(schedules).where(eq(schedules.id, scheduleId));

  return existing;
}

export function formatSchedule(row: typeof schedules.$inferSelect) {
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
