import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.js";
import {
  executeWebhook,
  recordExecution,
  advanceSchedule,
} from "../engine/executor.js";
import type { Env } from "../types.js";

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
      const result = await executeWebhook(
        transportConfig.url,
        JSON.parse(schedule.payload),
        transportConfig.headers ?? {},
        transportConfig.timeout_ms ?? 10000
      );

      await recordExecution(db, scheduleId, "webhook", result);
    } else if (schedule.transport_type === "websocket") {
      // WebSocket transport is not yet wired end-to-end across isolates/DO boundaries.
      await recordExecution(db, scheduleId, "websocket", {
        status: "failure",
        error:
          "WebSocket transport delivery is not yet available end-to-end; use webhook transport.",
        duration_ms: 0,
      });
    }

    // Advance to next run
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
