import { workflow } from "@agent-relay/sdk/workflows";

/**
 * Workflow: Rewrite packages/server + rename @agentcron → @relaycron
 *
 * 1. Rename all packages from @agentcron/* to @relaycron/*
 * 2. Remove all Cloudflare deps from packages/server:
 *    - D1 → better-sqlite3, DO alarms → setTimeout, crypto.subtle → Node crypto
 *    - Export createApp(db, scheduler) factory for cloud to wrap
 *    - Standalone server.ts entry point with @hono/node-server
 *
 * Repos touched: relaycron/ only
 */

async function main() {
  const result = await workflow("001-local-server")
    .description("Rename @agentcron→@relaycron, rewrite server to remove Cloudflare")
    .pattern("dag")
    .channel("wf-local-server")
    .maxConcurrency(4)
    .timeout(3_600_000)

    .agent("lead", { cli: "claude", role: "Architect", retries: 2 })
    .agent("worker-1", { cli: "claude", preset: "worker", role: "Storage and scheduler", retries: 2 })
    .agent("worker-2", { cli: "claude", preset: "worker", role: "Routes and middleware", retries: 2 })
    .agent("worker-3", { cli: "claude", preset: "worker", role: "Server entry point", retries: 2 })

    // ── Rename @agentcron → @relaycron ──────────────────────────────
    .step("rename-packages", {
      type: "deterministic",
      command: [
        "sed -i '' 's/@agentcron\\//@relaycron\\//g' package.json packages/types/package.json packages/sdk/package.json packages/server/package.json",
        "find packages -name '*.ts' -exec sed -i '' 's/@agentcron\\//@relaycron\\//g' {} +",
        "sed -i '' 's/\"name\": \"agentcron\"/\"name\": \"relaycron\"/' package.json",
        "test -f README.md && sed -i '' 's/@agentcron/@relaycron/g' README.md || true",
        "test -f CLAUDE.md && sed -i '' 's/@agentcron/@relaycron/g' CLAUDE.md || true",
        "test -f skill.md && sed -i '' 's/@agentcron/@relaycron/g; s/AgentCron/RelayCron/g' skill.md || true",
        "echo 'RENAME_DONE'",
      ].join(" && "),
      failOnError: true,
    })

    // ── Delete CF-only files ────────────────────────────────────────
    .step("remove-cf-files", {
      type: "deterministic",
      dependsOn: ["rename-packages"],
      command: [
        "rm -f wrangler.toml drizzle.config.ts",
        "rm -rf packages/server/src/durable-objects",
        "rm -rf packages/server/src/db/migrations",
        "echo 'CF_FILES_REMOVED'",
      ].join(" && "),
      failOnError: true,
    })

    // ── Save plan to file (avoids E2BIG from output chaining) ───────
    .step("write-plan", {
      type: "deterministic",
      dependsOn: ["remove-cf-files"],
      command: `cat > /tmp/relaycron-plan.md << 'PLAN_EOF'
# RelayCron Server Rewrite Plan

All packages renamed from @agentcron/* to @relaycron/*. CF files deleted.

## What to replace

| Cloudflare | Node.js replacement |
|---|---|
| D1 (drizzle-orm/d1) | better-sqlite3 (drizzle-orm/better-sqlite3) |
| DurableObject alarms | LocalScheduler with setTimeout |
| crypto.subtle.digest | Node crypto.createHash("sha256") |
| c.executionCtx.waitUntil | fire-and-forget .catch(() => {}) |
| Hono<{ Bindings: Env }> | plain Hono (db/scheduler via closure) |
| worker.ts (CF export) | server.ts (@hono/node-server) + app.ts (factory) |

## Files to create/rewrite in packages/server/

### package.json — remove CF deps, add Node deps
Remove: wrangler, @cloudflare/workers-types, drizzle-kit, deploy scripts
Add: @hono/node-server, better-sqlite3, @types/better-sqlite3, tsx
Scripts: start (tsx src/server.ts), dev (tsx watch src/server.ts), build (tsc)

### src/types.ts
- Database = BetterSQLite3Database<typeof schema> (from drizzle-orm/better-sqlite3)
- Scheduler interface: { setAlarm(id: string, runAt: string): void; cancelAlarm(id: string): void; }
- AuthContext: { apiKeyId: string }
- Extend Hono ContextVariableMap with db, auth

### src/db/schema.ts — NO CHANGES (already portable drizzle-orm/sqlite-core)

### src/db/sqlite.ts — NEW
- createDatabase(dbPath?) → drizzle instance
- Default path: process.env.RELAYCRON_DB_PATH || ".relaycron/relaycron.db"
- mkdirSync parent, open better-sqlite3, WAL mode, foreign keys ON
- CREATE TABLE IF NOT EXISTS for api_keys, schedules, executions

### src/middleware/db.ts
- createDbMiddleware(db: Database) → Hono middleware that sets c.set("db", db)

### src/middleware/auth.ts
- hashKey: createHash("sha256").update(key).digest("hex") (sync, not async)
- Remove executionCtx.waitUntil, use fire-and-forget

### src/routes/schedules.ts
- createSchedulesRouter(scheduler: Scheduler) → Hono router
- Replace all DO calls: scheduler.setAlarm(id, runAt), scheduler.cancelAlarm(id)

### src/routes/auth.ts + executions.ts — remove Bindings: Env type param only

### src/engine/scheduler.ts — NEW (replaces SchedulerDO)
- LocalScheduler implements Scheduler
- Map<string, NodeJS.Timeout> for timers
- setAlarm/cancelAlarm/cancelAll/restoreAlarms
- executeSchedule: fetch schedule → executeWebhookWithRetry → recordExecution → advanceSchedule → re-arm

### src/engine/executor.ts + cron.ts — NO CHANGES (already portable)

### src/app.ts — NEW (factory for cloud to import)
- createApp(db: Database, scheduler: Scheduler) → Hono
- Mount routes: /health, /v1/auth, /v1/schedules, /v1 (executions)

### src/server.ts — NEW (standalone entry, replaces worker.ts)
- createDatabase() → createApp(db, scheduler) → serve on PORT/4007
- Graceful shutdown: SIGINT/SIGTERM → scheduler.cancelAll()

### DELETE src/worker.ts
PLAN_EOF
echo 'PLAN_WRITTEN'`,
      failOnError: true,
    })

    // ── Rewrite package.json + types (worker-3) ─────────────────────
    .step("rewrite-package", {
      agent: "worker-3",
      dependsOn: ["write-plan"],
      task: `Rewrite packages/server/package.json and src/types.ts. Read /tmp/relaycron-plan.md for the full plan, and read the current files first.

packages/server/package.json — rewrite to:
- name: @relaycron/server, private: true, type: module
- main: dist/app.js, types: dist/app.d.ts
- exports: "." → app, "./scheduler" → engine/scheduler, "./db" → db/sqlite
- scripts: start (tsx src/server.ts), dev (tsx watch src/server.ts), build (tsc)
- deps: @relaycron/types *, @hono/node-server ^1.13.0, better-sqlite3 ^11.0.0, cron-parser ^5.0.0, drizzle-orm ^0.38.0, hono ^4.7.0, nanoid ^5.0.0
- devDeps: @types/better-sqlite3 ^7.6.0, tsx ^4.0.0, typescript ^5.7.0
- Remove ALL: wrangler, @cloudflare/workers-types, drizzle-kit, deploy scripts

src/types.ts — rewrite to:
- import { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
- import * as schema from "./db/schema.js"
- export type Database = BetterSQLite3Database<typeof schema>
- export interface Scheduler { setAlarm(id: string, runAt: string): void; cancelAlarm(id: string): void; }
- export interface AuthContext { apiKeyId: string }
- declare module "hono" { interface ContextVariableMap { db: Database; auth: AuthContext } }

Only edit these 2 files.`,
      verification: { type: "exit_code" },
    })

    .step("verify-package", {
      type: "deterministic",
      dependsOn: ["rewrite-package"],
      command: "grep -q 'better-sqlite3' packages/server/package.json && ! grep -q 'wrangler' packages/server/package.json && echo 'PACKAGE_OK'",
      failOnError: true,
    })

    // ── DB layer (worker-1) ─────────────────────────────────────────
    .step("impl-db", {
      agent: "worker-1",
      dependsOn: ["write-plan"],
      task: `Create packages/server/src/db/sqlite.ts — the better-sqlite3 database layer.

Read /tmp/relaycron-plan.md for the full plan. Read packages/server/src/db/schema.ts for the existing table definitions.

Create packages/server/src/db/sqlite.ts:
- import Database from "better-sqlite3"
- import { drizzle } from "drizzle-orm/better-sqlite3"
- import * as schema from "./schema.js"
- import { mkdirSync } from "node:fs", { dirname } from "node:path"
- export function createDatabase(dbPath?: string):
  - Default: process.env.RELAYCRON_DB_PATH || ".relaycron/relaycron.db"
  - mkdirSync parent dir
  - Open sqlite, WAL mode, foreign keys ON
  - CREATE TABLE IF NOT EXISTS for api_keys (id, name, key_hash, key_prefix, created_at, last_used_at)
  - CREATE TABLE IF NOT EXISTS for schedules (all columns from schema.ts including indices on api_key_id, status, next_run_at)
  - CREATE TABLE IF NOT EXISTS for executions (all columns including indices on schedule_id, started_at)
  - Return drizzle(sqlite, { schema })

Do NOT modify schema.ts. Only create sqlite.ts.`,
      verification: { type: "file_exists", value: "packages/server/src/db/sqlite.ts" },
    })

    .step("verify-db", {
      type: "deterministic",
      dependsOn: ["impl-db"],
      command: "test -f packages/server/src/db/sqlite.ts && echo 'DB_OK'",
      failOnError: true,
    })

    // ── Scheduler (worker-1, after DB + types) ──────────────────────
    .step("impl-scheduler", {
      agent: "worker-1",
      dependsOn: ["verify-db", "verify-package"],
      task: `Create packages/server/src/engine/scheduler.ts — replaces Durable Object alarms.

Read packages/server/src/types.ts for the Scheduler interface and Database type.
Read packages/server/src/engine/executor.ts for executeWebhookWithRetry, recordExecution, advanceSchedule.
Read packages/server/src/db/schema.ts for table definitions.

Create packages/server/src/engine/scheduler.ts:
- import { eq } from "drizzle-orm"
- import * as schema from "../db/schema.js"
- import { executeWebhookWithRetry, recordExecution, advanceSchedule } from "./executor.js"
- import type { Database, Scheduler } from "../types.js"

export class LocalScheduler implements Scheduler:
  private timers = new Map<string, NodeJS.Timeout>()
  private db: Database
  private RETRY_CONFIG = { maxAttempts: 3, initialBackoffMs: 1000, backoffMultiplier: 5 }

  constructor(db: Database) { this.db = db }

  setAlarm(scheduleId: string, runAt: string): void
    - Cancel existing timer, calculate delay, setTimeout → executeSchedule
    - If overdue (delay <= 0), fire with setTimeout(cb, 0)

  cancelAlarm(scheduleId: string): void — clearTimeout, delete from map
  cancelAll(): void — clear all timers

  private async executeSchedule(scheduleId: string): Promise<void>
    - Fetch schedule from DB, check active
    - If webhook: executeWebhookWithRetry with retry config, recordExecution
    - If websocket: recordExecution with failure
    - advanceSchedule → if nextRunAt: this.setAlarm(scheduleId, nextRunAt)

  async restoreAlarms(): Promise<void>
    - Select schedules where status="active" AND next_run_at IS NOT NULL
    - setAlarm for each, log count

Also update packages/server/src/engine/executor.ts: ensure it imports Database from "../types.js" (not from drizzle-orm/d1).
Leave cron.ts unchanged.`,
      verification: { type: "file_exists", value: "packages/server/src/engine/scheduler.ts" },
    })

    .step("verify-scheduler", {
      type: "deterministic",
      dependsOn: ["impl-scheduler"],
      command: "test -f packages/server/src/engine/scheduler.ts && echo 'SCHEDULER_OK'",
      failOnError: true,
    })

    // ── Middleware (worker-2) ────────────────────────────────────────
    .step("rewrite-middleware", {
      agent: "worker-2",
      dependsOn: ["verify-package"],
      task: `Rewrite packages/server/src/middleware/ to remove Cloudflare deps.

Read the current files first:
- packages/server/src/middleware/db.ts
- packages/server/src/middleware/auth.ts
- packages/server/src/types.ts

FILE 1: packages/server/src/middleware/db.ts — rewrite:
- import { createMiddleware } from "hono/factory"
- import type { Database } from "../types.js"
- export function createDbMiddleware(db: Database) — returns middleware that sets c.set("db", db)

FILE 2: packages/server/src/middleware/auth.ts — rewrite:
- import { createHash } from "node:crypto"
- export function hashKey(key: string): string — synchronous: createHash("sha256").update(key).digest("hex")
- requireAuth middleware: same logic but no Bindings type, no executionCtx.waitUntil
  - last_used_at update: db.update(...).then(() => {}).catch(() => {}) — fire and forget

Only edit these 2 files.`,
      verification: { type: "exit_code" },
    })

    .step("verify-middleware", {
      type: "deterministic",
      dependsOn: ["rewrite-middleware"],
      command: "! grep -q 'drizzle-orm/d1' packages/server/src/middleware/db.ts && ! grep -q 'crypto.subtle' packages/server/src/middleware/auth.ts && echo 'MIDDLEWARE_OK'",
      failOnError: true,
    })

    // ── Routes (worker-2, after middleware + scheduler) ──────────────
    .step("rewrite-routes", {
      agent: "worker-2",
      dependsOn: ["verify-middleware", "verify-scheduler"],
      task: `Rewrite routes to remove Durable Object references.

Read the current files first:
- packages/server/src/routes/schedules.ts
- packages/server/src/routes/auth.ts
- packages/server/src/routes/executions.ts
- packages/server/src/types.ts

FILE 1: packages/server/src/routes/schedules.ts — rewrite:
- export function createSchedulesRouter(scheduler: Scheduler) returning Hono router
- import type { Scheduler } from "../types.js"
- Replace DO stub.fetch("/set-alarm"...) → scheduler.setAlarm(id, nextRunAt)
- Replace DO stub.fetch("/cancel-alarm"...) → scheduler.cancelAlarm(id)
- Remove Hono<{ Bindings: Env }> — use plain Hono
- Remove c.env.SCHEDULER_DO references
- Keep ALL validation, CRUD, pagination, formatSchedule logic identical

FILE 2: packages/server/src/routes/auth.ts — remove Bindings: Env type param, keep everything else
FILE 3: packages/server/src/routes/executions.ts — remove Bindings: Env type param, keep everything else

Only edit these 3 files.`,
      verification: { type: "exit_code" },
    })

    .step("verify-routes", {
      type: "deterministic",
      dependsOn: ["rewrite-routes"],
      command: "! grep -q 'SCHEDULER_DO' packages/server/src/routes/schedules.ts && echo 'ROUTES_OK'",
      failOnError: true,
    })

    // ── App factory + server entry (worker-3) ───────────────────────
    .step("impl-app-and-server", {
      agent: "worker-3",
      dependsOn: ["verify-routes"],
      task: `Create app factory and server entry point. Read /tmp/relaycron-plan.md for context.

Read the rewritten modules first:
- packages/server/src/types.ts
- packages/server/src/middleware/db.ts
- packages/server/src/middleware/auth.ts
- packages/server/src/routes/schedules.ts (to see createSchedulesRouter signature)
- packages/server/src/routes/auth.ts
- packages/server/src/routes/executions.ts

FILE 1: packages/server/src/app.ts — NEW. What cloud imports.
- import Hono, cors, createDbMiddleware, requireAuth, route modules, types
- export function createApp(db: Database, scheduler: Scheduler): Hono
  - app.use("*", cors()), app.use("*", createDbMiddleware(db))
  - GET /health → { ok: true, data: { status: "healthy", version: "0.1.0" } }
  - app.route("/v1/auth", authRouter)
  - app.route("/v1/schedules", createSchedulesRouter(scheduler))
  - app.route("/v1", executionsRouter)
  - 404 + error handlers
  - return app
- Re-export: export type { Database, Scheduler } from "./types.js"

FILE 2: packages/server/src/server.ts — NEW. Standalone entry.
- import { serve } from "@hono/node-server"
- import { createDatabase } from "./db/sqlite.js"
- import { LocalScheduler } from "./engine/scheduler.js"
- import { createApp } from "./app.js"
- const db = createDatabase(), const scheduler = new LocalScheduler(db)
- await scheduler.restoreAlarms()
- serve({ fetch: createApp(db, scheduler).fetch, port: Number(process.env.PORT) || 4007 })
- console.log("RelayCron server running on http://localhost:" + port)
- SIGINT/SIGTERM → scheduler.cancelAll(), process.exit(0)

Only create these 2 files.`,
      verification: { type: "file_exists", value: "packages/server/src/app.ts" },
    })

    .step("cleanup-worker", {
      type: "deterministic",
      dependsOn: ["impl-app-and-server"],
      command: "rm -f packages/server/src/worker.ts && echo 'WORKER_DELETED'",
      failOnError: true,
    })

    // ── Final checks ────────────────────────────────────────────────
    .step("verify-no-cf", {
      type: "deterministic",
      dependsOn: ["cleanup-worker"],
      command: [
        "! grep -r 'D1Database' packages/server/src/",
        "! grep -r 'DurableObject' packages/server/src/",
        "! grep -r 'drizzle-orm/d1' packages/server/src/",
        "! grep -r 'crypto.subtle' packages/server/src/",
        "! grep -r 'executionCtx' packages/server/src/",
        "! grep -r '@agentcron' packages/*/src/",
        "test ! -f wrangler.toml",
        "test ! -f packages/server/src/worker.ts",
        "test -f packages/server/src/app.ts",
        "test -f packages/server/src/server.ts",
        "test -f packages/server/src/db/sqlite.ts",
        "test -f packages/server/src/engine/scheduler.ts",
        "echo 'ALL_CLEAN'",
      ].join(" && "),
      failOnError: true,
    })

    .step("install-and-build", {
      type: "deterministic",
      dependsOn: ["verify-no-cf"],
      command: "npm install && npx tsc --noEmit -p packages/server/tsconfig.json 2>&1 || echo 'BUILD_WARNINGS'",
      captureOutput: true,
    })

    .onError("retry", { maxRetries: 2, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  console.log("Result:", result.status);
}
main().catch(console.error);
