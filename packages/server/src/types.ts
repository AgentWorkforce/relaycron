import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "./db/schema.js";

export type Database = BetterSQLite3Database<typeof schema>;

export interface Scheduler {
  setAlarm(id: string, runAt: string): void;
  cancelAlarm(id: string): void;
}

export interface TickDispatchRequest {
  apiKeyId: string;
  scheduleId: string;
  scheduleName: string;
  executionId: string;
  payload: unknown;
  scheduledFor: string;
  occurredAt: string;
  coalesceMissedTicks: "none" | "fire-once";
}

export interface TickDispatcher {
  deliverTick(request: TickDispatchRequest): void;
}

export interface AuthContext {
  apiKeyId: string;
}

declare module "hono" {
  interface ContextVariableMap {
    db: Database;
    auth: AuthContext;
  }
}
