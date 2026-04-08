=== engine/executor.ts ===
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { schedules, executions } from "../db/schema.js";
import { getNextCronDate } from "./cron.js";
import type { Database } from "../types.js";

export interface ExecutionResult {
  status: "success" | "failure" | "timeout";
  http_status?: number;
  response_body?: string;
  error?: string;
  duration_ms: number;
  attempt_count: number;
}

export interface RetryConfig {
  maxAttempts: number;
  initialBackoffMs: number;
  backoffMultiplier: number;
}

export async function executeWebhook(
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
  timeoutMs: number = 10000
): Promise<ExecutionResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "AgentCron/1.0",
        "X-AgentCron-Delivery": nanoid(),
        ...headers,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const duration_ms = Date.now() - start;
    const body = await response.text().catch(() => "");

    return {
      status: response.ok ? "success" : "failure",
      http_status: response.status,
      response_body: body.slice(0, 4096),
      duration_ms,
      attempt_count: 1,
    };
  } catch (err) {
    const duration_ms = Date.now() - start;
    const isTimeout =
      err instanceof DOMException && err.name === "AbortError";
    return {
      status: isTimeout ? "timeout" : "failure",
      error: err instanceof Error ? err.message : "Unknown error",
      duration_ms,
      attempt_count: 1,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function shouldRetry(result: ExecutionResult): boolean {
  if (result.status === "success") {
    return false;
  }

  return !(
    typeof result.http_status === "number" &&
    result.http_status >= 400 &&
    result.http_status < 500
  );
}

function getBackoffDelayMs(
  retryConfig: RetryConfig,
  failedAttemptCount: number
): number {
  return retryConfig.initialBackoffMs *
    retryConfig.backoffMultiplier ** (failedAttemptCount - 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeWebhookWithRetry(
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
  timeoutMs: number = 10000,
  retryConfig: RetryConfig
): Promise<ExecutionResult> {
  const maxAttempts = Math.max(1, retryConfig.maxAttempts);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await executeWebhook(url, payload, headers, timeoutMs);

    if (attempt === maxAttempts || !shouldRetry(result)) {
      return {
        ...result,
        attempt_count: attempt,
      };
    }

    await sleep(getBackoffDelayMs(retryConfig, attempt));
  }

  throw new Error("Webhook retry loop exited without returning a result");
}

export async function recordExecution(
  db: Database,
  scheduleId: string,
  transportType: "webhook" | "websocket",
  result: ExecutionResult
): Promise<string> {
  const executionId = nanoid();
  const now = new Date().toISOString();

  await db.insert(executions).values({
    id: executionId,
    schedule_id: scheduleId,
    started_at: now,
    completed_at: now,
    status: result.status,
    transport_type: transportType,
    http_status: result.http_status ?? null,
    response_body: result.response_body ?? null,
    error: result.error ?? null,
    duration_ms: result.duration_ms,
  });

  // Update schedule counters
  const updates: Record<string, unknown> = {
    last_run_at: now,
    run_count: sql`${schedules.run_count} + 1`,
    updated_at: now,
  };
  if (result.status !== "success") {
    updates.failure_count = sql`${schedules.failure_count} + 1`;
  }

  await db.update(schedules).set(updates).where(eq(schedules.id, scheduleId));

  return executionId;
}

export async function advanceSchedule(
  db: Database,
  scheduleId: string,
  scheduleType: string,
  cronExpression: string | null,
  timezone: string
): Promise<string | null> {
  if (scheduleType === "once") {
    await db
      .update(schedules)
      .set({ status: "completed", next_run_at: null, updated_at: new Date().toISOString() })
      .where(eq(schedules.id, scheduleId));
    return null;
  }

  if (scheduleType === "cron" && cronExpression) {
    const next = getNextCronDate(cronExpression, timezone);
    if (next) {
      const nextIso = next.toISOString();
      await db
        .update(schedules)
        .set({ next_run_at: nextIso, updated_at: new Date().toISOString() })
        .where(eq(schedules.id, scheduleId));
      return nextIso;
    }
  }

  return null;
}
=== engine/cron.ts ===
import { CronExpressionParser } from "cron-parser";

export function getNextCronDate(
  expression: string,
  timezone: string
): Date | null {
  try {
    const cron = CronExpressionParser.parse(expression, {
      currentDate: new Date(),
      tz: timezone,
    });
    return cron.next().toDate();
  } catch {
    return null;
  }
}

export function isValidCron(expression: string): boolean {
  try {
    CronExpressionParser.parse(expression);
    return true;
  } catch {
    return false;
  }
}
=== durable-objects/scheduler-do.ts ===
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.js";
import {
  executeWebhookWithRetry,
  recordExecution,
  advanceSchedule,
} from "../engine/executor.js";
import type { Env } from "../types.js";

const WEBHOOK_RETRY_CONFIG = {
  maxAttempts: 3,
  initialBackoffMs: 1000,
  backoffMultiplier: 5,
} as const;

/**
 * Each schedule gets its own SchedulerDO instance.
 * It uses Durable Object alarms to fire at the exact scheduled time.
 * When the alarm fires, it executes the transport and advances the schedule.
 */
export class SchedulerDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/set-alarm" && request.method === "POST") {
      const { schedule_id, run_at } = (await request.json()) as {
        schedule_id: string;
        run_at: string;
      };
      await this.state.storage.put("schedule_id", schedule_id);
      const alarmTime = new Date(run_at).getTime();
      await this.state.storage.setAlarm(alarmTime);
      return new Response("OK");
    }

    if (url.pathname === "/cancel-alarm" && request.method === "POST") {
      await this.state.storage.deleteAlarm();
      return new Response("OK");
    }

    return new Response("Not Found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const scheduleId = (await this.state.storage.get(
      "schedule_id"
    )) as string;
    if (!scheduleId) return;

    const db = drizzle(this.env.DB, { schema });

    const [schedule] = await db
      .select()
      .from(schema.schedules)
      .where(eq(schema.schedules.id, scheduleId))
      .limit(1);

    if (!schedule || schedule.status !== "active") return;

    const transportConfig = JSON.parse(schedule.transport_config);

    // Execute based on transport type
    if (schedule.transport_type === "webhook") {
      const result = await executeWebhookWithRetry(
        transportConfig.url,
        JSON.parse(schedule.payload),
        transportConfig.headers ?? {},
        transportConfig.timeout_ms ?? 10000,
        WEBHOOK_RETRY_CONFIG
      );

      await recordExecution(db, scheduleId, "webhook", result);
    } else if (schedule.transport_type === "websocket") {
      // WebSocket transport is not yet wired end-to-end across isolates/DO boundaries.
      await recordExecution(db, scheduleId, "websocket", {
        status: "failure",
        error:
          "WebSocket transport delivery is not yet available end-to-end; use webhook transport.",
        duration_ms: 0,
        attempt_count: 1,
      });
    }

    // Advance to the next run even after terminal delivery failure.
    const nextRunAt = await advanceSchedule(
      db,
      scheduleId,
      schedule.schedule_type,
      schedule.cron_expression,
      schedule.timezone
    );

    // Set next alarm if recurring
    if (nextRunAt) {
      await this.state.storage.setAlarm(new Date(nextRunAt).getTime());
    }
  }
}
=== db/schema.ts ===
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  key_hash: text("key_hash").notNull(),
  key_prefix: text("key_prefix").notNull(),
  created_at: text("created_at").notNull(),
  last_used_at: text("last_used_at"),
});

export const schedules = sqliteTable("schedules", {
  id: text("id").primaryKey(),
  api_key_id: text("api_key_id")
    .notNull()
    .references(() => apiKeys.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  schedule_type: text("schedule_type", { enum: ["once", "cron"] }).notNull(),
  cron_expression: text("cron_expression"),
  scheduled_at: text("scheduled_at"),
  timezone: text("timezone").notNull().default("UTC"),
  payload: text("payload").notNull(), // JSON
  transport_type: text("transport_type", {
    enum: ["webhook", "websocket"],
  }).notNull(),
  transport_config: text("transport_config").notNull(), // JSON
  status: text("status", {
    enum: ["active", "paused", "completed", "expired"],
  })
    .notNull()
    .default("active"),
  next_run_at: text("next_run_at"),
  last_run_at: text("last_run_at"),
  run_count: integer("run_count").notNull().default(0),
  failure_count: integer("failure_count").notNull().default(0),
  metadata: text("metadata"), // JSON
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
});

export const executions = sqliteTable("executions", {
  id: text("id").primaryKey(),
  schedule_id: text("schedule_id")
    .notNull()
    .references(() => schedules.id, { onDelete: "cascade" }),
  started_at: text("started_at").notNull(),
  completed_at: text("completed_at"),
  status: text("status", {
    enum: ["success", "failure", "timeout"],
  }).notNull(),
  transport_type: text("transport_type", {
    enum: ["webhook", "websocket"],
  }).notNull(),
  http_status: integer("http_status"),
  response_body: text("response_body"),
  error: text("error"),
  duration_ms: integer("duration_ms"),
});
