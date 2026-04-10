import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function createDatabase(dbPath?: string) {
  const resolvedPath =
    dbPath || process.env.RELAYCRON_DB_PATH || ".relaycron/relaycron.db";

  mkdirSync(dirname(resolvedPath), { recursive: true });

  const sqlite = new Database(resolvedPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      schedule_type TEXT NOT NULL CHECK (schedule_type IN ('once', 'cron')),
      cron_expression TEXT,
      scheduled_at TEXT,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      payload TEXT NOT NULL,
      transport_type TEXT NOT NULL CHECK (transport_type IN ('webhook', 'websocket')),
      transport_config TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'expired')),
      next_run_at TEXT,
      last_run_at TEXT,
      run_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_schedules_api_key_id ON schedules(api_key_id);
    CREATE INDEX IF NOT EXISTS idx_schedules_status ON schedules(status);
    CREATE INDEX IF NOT EXISTS idx_schedules_next_run_at ON schedules(next_run_at);

    CREATE TABLE IF NOT EXISTS executions (
      id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('success', 'failure', 'timeout')),
      transport_type TEXT NOT NULL CHECK (transport_type IN ('webhook', 'websocket')),
      http_status INTEGER,
      response_body TEXT,
      error TEXT,
      duration_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_executions_schedule_id ON executions(schedule_id);
    CREATE INDEX IF NOT EXISTS idx_executions_started_at ON executions(started_at);
    CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);
  `);

  return drizzle(sqlite, { schema });
}
