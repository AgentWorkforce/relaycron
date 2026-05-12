import { eq, and, isNotNull } from "drizzle-orm";
import * as schema from "../db/schema.js";
import {
  executeWebhookWithRetry,
  recordExecution,
  advanceSchedule,
} from "./executor.js";
import type { Database, Scheduler, TickDispatcher } from "../types.js";
import type { RetryConfig } from "./executor.js";

export class LocalScheduler implements Scheduler {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private db: Database;
  private tickDispatcher: TickDispatcher | null;
  private RETRY_CONFIG: RetryConfig = {
    maxAttempts: 3,
    initialBackoffMs: 1000,
    backoffMultiplier: 5,
  };

  constructor(db: Database, tickDispatcher?: TickDispatcher) {
    this.db = db;
    this.tickDispatcher = tickDispatcher ?? null;
  }

  setTickDispatcher(tickDispatcher: TickDispatcher): void {
    this.tickDispatcher = tickDispatcher;
  }

  setAlarm(scheduleId: string, runAt: string): void {
    // Cancel any existing timer for this schedule
    this.cancelAlarm(scheduleId);

    const delay = new Date(runAt).getTime() - Date.now();
    const timer = setTimeout(
      () => {
        this.timers.delete(scheduleId);
        this.executeSchedule(scheduleId).catch((err) => {
          console.error(
            `[scheduler] failed to execute schedule ${scheduleId}:`,
            err
          );
        });
      },
      delay <= 0 ? 0 : delay
    );

    this.timers.set(scheduleId, timer);
  }

  cancelAlarm(scheduleId: string): void {
    const timer = this.timers.get(scheduleId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(scheduleId);
    }
  }

  cancelAll(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private async executeSchedule(scheduleId: string): Promise<void> {
    const schedule = await this.db
      .select()
      .from(schema.schedules)
      .where(eq(schema.schedules.id, scheduleId))
      .get();

    if (!schedule || schedule.status !== "active") {
      return;
    }

    const payload = JSON.parse(schedule.payload);
    const transportConfig = JSON.parse(schedule.transport_config) as
      | {
          url: string;
          headers?: Record<string, string>;
          timeout_ms?: number;
        }
      | {
          channel?: string;
          coalesce_missed_ticks?: "none" | "fire-once";
        };
    const scheduledFor = schedule.next_run_at ?? new Date().toISOString();
    const startedAt = Date.now();
    let executionResult;
    let executionId: string | null = null;

    if (schedule.transport_type === "webhook") {
      const config = transportConfig as {
        url: string;
        headers?: Record<string, string>;
        timeout_ms?: number;
      };

      executionResult = await executeWebhookWithRetry(
        config.url,
        payload,
        config.headers ?? {},
        config.timeout_ms ?? 10000,
        this.RETRY_CONFIG
      );
      executionId = await recordExecution(
        this.db,
        scheduleId,
        "webhook",
        executionResult
      );
    } else {
      if (!this.tickDispatcher) {
        executionResult = {
          status: "failure" as const,
          error: "WebSocket transport is not configured on this relaycron server",
          duration_ms: Date.now() - startedAt,
          attempt_count: 1,
        };
        executionId = await recordExecution(
          this.db,
          scheduleId,
          "websocket",
          executionResult
        );
      } else {
        executionResult = {
          status: "success" as const,
          duration_ms: Date.now() - startedAt,
          attempt_count: 1,
        };
        executionId = await recordExecution(
          this.db,
          scheduleId,
          "websocket",
          executionResult
        );
        await this.tickDispatcher.deliverTick({
          apiKeyId: schedule.api_key_id,
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          executionId,
          payload,
          scheduledFor,
          occurredAt: new Date().toISOString(),
          coalesceMissedTicks:
            (transportConfig as {
              coalesce_missed_ticks?: "none" | "fire-once";
            }).coalesce_missed_ticks ?? "none",
        });
      }
    }

    const nextRunAt = await advanceSchedule(
      this.db,
      scheduleId,
      schedule.schedule_type,
      schedule.cron_expression,
      schedule.timezone
    );

    if (nextRunAt) {
      this.setAlarm(scheduleId, nextRunAt);
    }
  }

  async restoreAlarms(): Promise<void> {
    const activeSchedules = await this.db
      .select()
      .from(schema.schedules)
      .where(
        and(
          eq(schema.schedules.status, "active"),
          isNotNull(schema.schedules.next_run_at)
        )
      )
      .all();

    for (const schedule of activeSchedules) {
      this.setAlarm(schedule.id, schedule.next_run_at!);
    }

    console.log(
      `[scheduler] restored ${activeSchedules.length} alarm(s)`
    );
  }
}
