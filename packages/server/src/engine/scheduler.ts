import { eq, and, isNotNull } from "drizzle-orm";
import * as schema from "../db/schema.js";
import {
  executeWebhookWithRetry,
  recordExecution,
  advanceSchedule,
} from "./executor.js";
import type { Database, Scheduler } from "../types.js";
import type { RetryConfig } from "./executor.js";

export class LocalScheduler implements Scheduler {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private db: Database;
  private RETRY_CONFIG: RetryConfig = {
    maxAttempts: 3,
    initialBackoffMs: 1000,
    backoffMultiplier: 5,
  };

  constructor(db: Database) {
    this.db = db;
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

    if (schedule.transport_type === "webhook") {
      const config = JSON.parse(schedule.transport_config) as {
        url: string;
        headers?: Record<string, string>;
        timeout_ms?: number;
      };

      const result = await executeWebhookWithRetry(
        config.url,
        payload,
        config.headers ?? {},
        config.timeout_ms ?? 10000,
        this.RETRY_CONFIG
      );

      await recordExecution(this.db, scheduleId, "webhook", result);
    } else {
      // WebSocket transport not supported in local scheduler
      await recordExecution(this.db, scheduleId, "websocket", {
        status: "failure",
        error: "WebSocket transport is not supported in local scheduler mode",
        duration_ms: 0,
        attempt_count: 1,
      });
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
