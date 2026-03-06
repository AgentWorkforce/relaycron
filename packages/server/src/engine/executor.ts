import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { schedules, executions } from "../db/schema.js";
import { getNextCronDate } from "./cron.js";
import type { Database } from "../types.js";

interface ExecutionResult {
  status: "success" | "failure" | "timeout";
  http_status?: number;
  response_body?: string;
  error?: string;
  duration_ms: number;
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
    };
  } catch (err) {
    const duration_ms = Date.now() - start;
    const isTimeout =
      err instanceof DOMException && err.name === "AbortError";
    return {
      status: isTimeout ? "timeout" : "failure",
      error: err instanceof Error ? err.message : "Unknown error",
      duration_ms,
    };
  } finally {
    clearTimeout(timeout);
  }
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
