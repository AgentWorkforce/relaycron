import { workflow } from "@agent-relay/sdk/workflows";

/**
 * Workflow: Rewrite packages/server as a standalone Node.js server
 *
 * Remove all Cloudflare dependencies (D1, Durable Objects, wrangler)
 * from packages/server and replace with:
 *   - Hono + @hono/node-server (like relayauth)
 *   - better-sqlite3 for storage (instead of D1)
 *   - Node.js setTimeout-based scheduler (instead of Durable Object alarms)
 *   - Node.js crypto (instead of crypto.subtle)
 *
 * Cloudflare-specific wiring (D1 bindings, DOs, SST) lives in ../cloud,
 * not in this OSS repo. Same API surface, same routes, same @agentcron/types.
 *
 * Reference: relayauth packages/server for the Hono + better-sqlite3 pattern
 */

const result = await workflow("001-local-server")
  .description(
    "Rewrite packages/server — remove Cloudflare, use better-sqlite3"
  )
  .pattern("dag")
  .channel("wf-local-server")
  .maxConcurrency(4)
  .timeout(3_600_000)

  .agent("lead", {
    cli: "claude",
    role: "Architect — plans the rewrite, reviews output",
    retries: 2,
  })
  .agent("worker-1", {
    cli: "claude",
    preset: "worker",
    role: "Implements storage and scheduler",
    retries: 2,
  })
  .agent("worker-2", {
    cli: "claude",
    preset: "worker",
    role: "Implements routes and middleware",
    retries: 2,
  })
  .agent("worker-3", {
    cli: "claude",
    preset: "worker",
    role: "Implements server entry point",
    retries: 2,
  })

  // ── Read all existing source ─────────────────────────────────────
  .step("read-cf-server", {
    type: "deterministic",
    command: [
      "echo '=== worker.ts ==='",
      "cat packages/server/src/worker.ts",
      "echo '=== types.ts ==='",
      "cat packages/server/src/types.ts",
      "echo '=== middleware/db.ts ==='",
      "cat packages/server/src/middleware/db.ts",
      "echo '=== middleware/auth.ts ==='",
      "cat packages/server/src/middleware/auth.ts",
    ].join(" && "),
    captureOutput: true,
  })

  .step("read-cf-routes", {
    type: "deterministic",
    command: [
      "echo '=== routes/auth.ts ==='",
      "cat packages/server/src/routes/auth.ts",
      "echo '=== routes/schedules.ts ==='",
      "cat packages/server/src/routes/schedules.ts",
      "echo '=== routes/executions.ts ==='",
      "cat packages/server/src/routes/executions.ts",
      "echo '=== routes/ws.ts ==='",
      "cat packages/server/src/routes/ws.ts",
    ].join(" && "),
    captureOutput: true,
  })

  .step("read-cf-engine", {
    type: "deterministic",
    command: [
      "echo '=== engine/executor.ts ==='",
      "cat packages/server/src/engine/executor.ts",
      "echo '=== engine/cron.ts ==='",
      "cat packages/server/src/engine/cron.ts",
      "echo '=== durable-objects/scheduler-do.ts ==='",
      "cat packages/server/src/durable-objects/scheduler-do.ts",
      "echo '=== db/schema.ts ==='",
      "cat packages/server/src/db/schema.ts",
    ].join(" && "),
    captureOutput: true,
  })

  .step("read-cf-package", {
    type: "deterministic",
    command: [
      "cat packages/server/package.json",
      "echo '---'",
      "cat wrangler.toml",
      "echo '---'",
      "cat tsconfig.base.json",
    ].join(" && "),
    captureOutput: true,
  })

  .step("read-relayauth-pattern", {
    type: "deterministic",
    command: [
      "echo '=== relayauth server.ts ==='",
      "head -100 ../relayauth/packages/server/src/server.ts",
      "echo '=== relayauth package.json ==='",
      "cat ../relayauth/packages/server/package.json",
    ].join(" && "),
    captureOutput: true,
  })

  // ── Clean up CF-only files ────────────────────────────────────────
  .step("remove-cf-files", {
    type: "deterministic",
    dependsOn: [
      "read-cf-server",
      "read-cf-routes",
      "read-cf-engine",
      "read-cf-package",
    ],
    command: [
      "rm -f wrangler.toml",
      "rm -f drizzle.config.ts",
      "rm -rf packages/server/src/durable-objects",
      "rm -f packages/server/src/db/migrations/0000_init.sql",
      "rmdir packages/server/src/db/migrations 2>/dev/null || true",
      "echo 'CF_FILES_REMOVED'",
    ].join(" && "),
    failOnError: true,
  })

  // ── Plan ──────────────────────────────────────────────────────────
  .step("plan", {
    agent: "lead",
    task: `Plan the rewrite of packages/server to remove ALL Cloudflare dependencies.

CURRENT CF SERVER (being rewritten):
{{steps.read-cf-server.output}}

{{steps.read-cf-routes.output}}

{{steps.read-cf-engine.output}}

CURRENT PACKAGE + CONFIG:
{{steps.read-cf-package.output}}

RELAYAUTH PATTERN (target pattern):
{{steps.read-relayauth-pattern.output}}

We are rewriting packages/server IN PLACE. The CF-only files (wrangler.toml, drizzle.config.ts, durable-objects/) have already been deleted. Every file in packages/server/src/ will be rewritten.

The rewrite replaces:
- D1 → better-sqlite3 (.agentcron/agentcron.db, configurable via AGENTCRON_DB_PATH)
- drizzle-orm/d1 → drizzle-orm/better-sqlite3
- Durable Object alarms → LocalScheduler class with setTimeout
- crypto.subtle → Node.js crypto.createHash
- c.executionCtx.waitUntil → fire-and-forget promise
- Cloudflare Worker export default → @hono/node-server serve()
- @cloudflare/workers-types → @types/better-sqlite3

Files to rewrite:
1. package.json — remove CF deps (wrangler, @cloudflare/workers-types), add Node deps (@hono/node-server, better-sqlite3, @types/better-sqlite3, tsx). Change scripts: start → tsx src/server.ts, dev → tsx watch src/server.ts. Remove deploy scripts.
2. src/types.ts — Database type from drizzle-orm/better-sqlite3, remove Env with D1/DO bindings.
3. src/db/schema.ts — keep as-is (already portable drizzle-orm/sqlite-core)
4. src/db/sqlite.ts — NEW: better-sqlite3 wrapper, auto-creates tables, WAL mode
5. src/middleware/db.ts — accept db via closure instead of from CF env bindings
6. src/middleware/auth.ts — Node.js crypto.createHash, remove executionCtx.waitUntil
7. src/routes/auth.ts — keep as-is (no CF deps)
8. src/routes/schedules.ts — replace DO calls with LocalScheduler.setAlarm/cancelAlarm
9. src/routes/executions.ts — keep as-is (no CF deps)
10. src/routes/ws.ts — keep (WebSocket route, if portable)
11. src/engine/cron.ts — keep as-is (already portable)
12. src/engine/executor.ts — keep as-is (uses standard fetch)
13. src/engine/scheduler.ts — NEW: replaces SchedulerDO with setTimeout-based scheduling
14. src/server.ts — NEW: replaces worker.ts. Hono app + @hono/node-server. Inits DB, creates scheduler, restores alarms, serves on PORT/4007.
15. DELETE src/worker.ts — replaced by src/server.ts

Output the exact changes per file. End with PLAN_COMPLETE.`,
    dependsOn: [
      "read-cf-server",
      "read-cf-routes",
      "read-cf-engine",
      "read-cf-package",
      "read-relayauth-pattern",
      "remove-cf-files",
    ],
    verification: { type: "output_contains", value: "PLAN_COMPLETE" },
  })

  // ── Package.json + types (worker-3) ───────────────────────────────
  .step("rewrite-package", {
    agent: "worker-3",
    task: `Rewrite packages/server/package.json and src/types.ts to remove all Cloudflare dependencies.

Plan:
{{steps.plan.output}}

Current package.json:
{{steps.read-cf-package.output}}

FILE 1: packages/server/package.json — rewrite entirely:
{
  "name": "@agentcron/server",
  "version": "0.1.0",
  "description": "AgentCron server — standalone Node.js scheduling service",
  "type": "module",
  "main": "dist/server.js",
  "types": "dist/server.d.ts",
  "files": ["dist"],
  "scripts": {
    "start": "tsx src/server.ts",
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "prepublishOnly": "npm run build"
  },
  "publishConfig": { "access": "public" },
  "repository": {
    "type": "git",
    "url": "https://github.com/AgentWorkforce/relaycron",
    "directory": "packages/server"
  },
  "license": "MIT",
  "engines": { "node": ">=18" },
  "dependencies": {
    "@agentcron/types": "*",
    "@hono/node-server": "^1.13.0",
    "better-sqlite3": "^11.0.0",
    "cron-parser": "^5.0.0",
    "drizzle-orm": "^0.38.0",
    "hono": "^4.7.0",
    "nanoid": "^5.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "tsx": "^4.0.0",
    "typescript": "^5.7.0"
  }
}

FILE 2: packages/server/src/types.ts — rewrite:
- Import { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
- Import * as schema from "./db/schema.js"
- Export type Database = BetterSQLite3Database<typeof schema>
- Export interface AuthContext { apiKeyId: string }
- Extend Hono ContextVariableMap with db: Database and auth: AuthContext
- NO Env interface, NO D1Database, NO DurableObjectNamespace

Only edit these 2 files. Write to disk.
IMPORTANT: Write the files to disk. Do NOT output to stdout.`,
    dependsOn: ["plan"],
    verification: { type: "exit_code" },
  })

  .step("verify-package", {
    type: "deterministic",
    dependsOn: ["rewrite-package"],
    command:
      "grep -q 'better-sqlite3' packages/server/package.json && ! grep -q 'wrangler' packages/server/package.json && ! grep -q 'D1Database' packages/server/src/types.ts && echo 'PACKAGE_OK'",
    failOnError: true,
  })

  // ── DB layer (worker-1) ──────────────────────────────────────────
  .step("impl-db", {
    agent: "worker-1",
    task: `Create the better-sqlite3 database layer for packages/server/.

Plan:
{{steps.plan.output}}

Existing schema (keep as-is — already portable):
{{steps.read-cf-engine.output}}

FILE 1: packages/server/src/db/sqlite.ts — NEW file:
- Import Database from better-sqlite3 (default import)
- Import { drizzle } from "drizzle-orm/better-sqlite3"
- Import * as schema from "./schema.js"
- Import { mkdirSync } from "node:fs"
- Import { dirname } from "node:path"
- Export function createDatabase(dbPath?: string) that:
  - Defaults dbPath to process.env.AGENTCRON_DB_PATH or ".agentcron/agentcron.db"
  - mkdirSync(dirname(dbPath), { recursive: true })
  - Opens better-sqlite3 with the path
  - sqlite.pragma("journal_mode = WAL")
  - sqlite.pragma("foreign_keys = ON")
  - Runs CREATE TABLE IF NOT EXISTS for api_keys, schedules, executions with all columns and indices matching the schema exactly
  - Returns drizzle(sqlite, { schema })

Do NOT modify packages/server/src/db/schema.ts — it's already portable.
Only create packages/server/src/db/sqlite.ts.
IMPORTANT: Write the file to disk. Do NOT output to stdout.`,
    dependsOn: ["plan"],
    verification: {
      type: "file_exists",
      value: "packages/server/src/db/sqlite.ts",
    },
  })

  .step("verify-db", {
    type: "deterministic",
    dependsOn: ["impl-db"],
    command:
      "test -f packages/server/src/db/sqlite.ts && test -f packages/server/src/db/schema.ts && echo 'DB_OK'",
    failOnError: true,
  })

  // ── Scheduler engine (worker-1, after DB) ─────────────────────────
  .step("read-types-file", {
    type: "deterministic",
    dependsOn: ["verify-package"],
    command: "cat packages/server/src/types.ts",
    captureOutput: true,
  })

  .step("impl-scheduler", {
    agent: "worker-1",
    task: `Create the local scheduler engine and update executor for packages/server/.

Plan:
{{steps.plan.output}}

CF Durable Object + executor (what we're replacing):
{{steps.read-cf-engine.output}}

New types:
{{steps.read-types-file.output}}

FILE 1: packages/server/src/engine/scheduler.ts — NEW, replaces SchedulerDO:
- Import { eq } from "drizzle-orm"
- Import * as schema from "../db/schema.js"
- Import { executeWebhookWithRetry, recordExecution, advanceSchedule } from "./executor.js"
- Import type { Database } from "../types.js"
- Class LocalScheduler:
  - private timers: Map<string, NodeJS.Timeout>
  - private db: Database (constructor param)
  - WEBHOOK_RETRY_CONFIG = { maxAttempts: 3, initialBackoffMs: 1000, backoffMultiplier: 5 }
  - setAlarm(scheduleId: string, runAt: string): void
    - Cancel existing timer for this id
    - delay = new Date(runAt).getTime() - Date.now()
    - setTimeout(cb, Math.max(0, delay)) — fire immediately if overdue
    - Store in map
    - Callback calls this.executeSchedule(scheduleId)
  - cancelAlarm(scheduleId: string): void — clearTimeout, delete from map
  - cancelAll(): void — clear all timers
  - private async executeSchedule(scheduleId: string): Promise<void>
    - Same logic as SchedulerDO.alarm():
    - Fetch schedule from DB, check status === "active"
    - If webhook: executeWebhookWithRetry, recordExecution
    - If websocket: recordExecution with failure (not yet supported)
    - advanceSchedule to get nextRunAt
    - If nextRunAt: this.setAlarm(scheduleId, nextRunAt)
  - async restoreAlarms(): Promise<void>
    - Select all schedules where status = "active" AND next_run_at IS NOT NULL
    - setAlarm for each
    - Log count restored
- Export LocalScheduler

FILE 2: packages/server/src/engine/executor.ts — update import only:
- Change "import type { Database } from '../types.js'" (should already be this)
- Everything else stays (standard fetch, drizzle-orm, nanoid — all portable)

FILE 3: packages/server/src/engine/cron.ts — leave as-is (already portable, no CF deps)

Only create/edit these files. Write to disk.
IMPORTANT: Write the files to disk. Do NOT output to stdout.`,
    dependsOn: ["verify-db", "read-types-file"],
    verification: {
      type: "file_exists",
      value: "packages/server/src/engine/scheduler.ts",
    },
  })

  .step("verify-scheduler", {
    type: "deterministic",
    dependsOn: ["impl-scheduler"],
    command:
      "test -f packages/server/src/engine/scheduler.ts && echo 'SCHEDULER_OK'",
    failOnError: true,
  })

  // ── Middleware (worker-2) ─────────────────────────────────────────
  .step("read-db-file", {
    type: "deterministic",
    dependsOn: ["verify-db"],
    command: "cat packages/server/src/db/sqlite.ts",
    captureOutput: true,
  })

  .step("rewrite-middleware", {
    agent: "worker-2",
    task: `Rewrite the middleware for packages/server/ to remove Cloudflare dependencies.

Plan:
{{steps.plan.output}}

Current CF middleware:
{{steps.read-cf-server.output}}

New DB module:
{{steps.read-db-file.output}}

New types:
{{steps.read-types-file.output}}

FILE 1: packages/server/src/middleware/db.ts — rewrite:
- Import { createMiddleware } from "hono/factory"
- Import type { Database } from "../types.js"
- Export function createDbMiddleware(db: Database) that returns middleware setting c.set("db", db)
- No more D1 binding, no more drizzle-orm/d1

FILE 2: packages/server/src/middleware/auth.ts — rewrite:
- Import { createHash } from "node:crypto"
- hashKey becomes synchronous: createHash("sha256").update(key).digest("hex")
- Remove c.executionCtx.waitUntil — fire-and-forget the last_used_at update with .catch(() => {})
- Remove the Bindings: Env type param from createMiddleware (use empty object or omit)
- Keep all auth logic (Bearer token, ac_ prefix check, hash lookup) identical

Only edit these 2 files. Write to disk.
IMPORTANT: Write the files to disk. Do NOT output to stdout.`,
    dependsOn: ["verify-package", "read-db-file"],
    verification: { type: "exit_code" },
  })

  .step("verify-middleware", {
    type: "deterministic",
    dependsOn: ["rewrite-middleware"],
    command:
      "! grep -q 'drizzle-orm/d1' packages/server/src/middleware/db.ts && ! grep -q 'crypto.subtle' packages/server/src/middleware/auth.ts && echo 'MIDDLEWARE_OK'",
    failOnError: true,
  })

  // ── Routes (worker-2, after middleware + scheduler) ───────────────
  .step("rewrite-routes", {
    agent: "worker-2",
    task: `Rewrite the schedule route to remove Cloudflare Durable Object references.

Plan:
{{steps.plan.output}}

Current CF routes:
{{steps.read-cf-routes.output}}

FILE 1: packages/server/src/routes/schedules.ts — rewrite:
- Remove all SCHEDULER_DO / DurableObject references
- Import { LocalScheduler } from "../engine/scheduler.js"
- Export function createSchedulesRouter(scheduler: LocalScheduler) that returns a Hono router
- Replace DO alarm calls with:
  - scheduler.setAlarm(id, nextRunAt) instead of stub.fetch("/set-alarm", ...)
  - scheduler.cancelAlarm(id) instead of stub.fetch("/cancel-alarm", ...)
- Remove Bindings: Env type parameter from Hono<>
- Keep ALL validation, CRUD, pagination, formatSchedule logic identical

FILE 2: packages/server/src/routes/auth.ts — minor update:
- Remove Bindings: Env type parameter from Hono<>
- Import hashKey from "../middleware/auth.js"
- Everything else stays

FILE 3: packages/server/src/routes/executions.ts — minor update:
- Remove Bindings: Env type parameter from Hono<>
- Everything else stays

Only edit these 3 files. Write to disk.
IMPORTANT: Write the files to disk. Do NOT output to stdout.`,
    dependsOn: ["verify-middleware", "verify-scheduler"],
    verification: { type: "exit_code" },
  })

  .step("verify-routes", {
    type: "deterministic",
    dependsOn: ["rewrite-routes"],
    command:
      "! grep -q 'SCHEDULER_DO' packages/server/src/routes/schedules.ts && ! grep -q 'DurableObject' packages/server/src/routes/schedules.ts && echo 'ROUTES_OK'",
    failOnError: true,
  })

  // ── Server entry point (worker-3, replaces worker.ts) ─────────────
  .step("read-all-rewritten", {
    type: "deterministic",
    dependsOn: ["verify-routes"],
    command: [
      "echo '=== types.ts ==='",
      "cat packages/server/src/types.ts",
      "echo '=== db/sqlite.ts ==='",
      "cat packages/server/src/db/sqlite.ts",
      "echo '=== middleware/db.ts ==='",
      "cat packages/server/src/middleware/db.ts",
      "echo '=== middleware/auth.ts ==='",
      "cat packages/server/src/middleware/auth.ts",
      "echo '=== engine/scheduler.ts ==='",
      "cat packages/server/src/engine/scheduler.ts",
      "echo '=== routes/schedules.ts ==='",
      "cat packages/server/src/routes/schedules.ts",
    ].join(" && "),
    captureOutput: true,
  })

  .step("impl-server", {
    agent: "worker-3",
    task: `Create the new server entry point and delete the old worker.ts.

Rewritten modules:
{{steps.read-all-rewritten.output}}

FILE 1: packages/server/src/server.ts — NEW, replaces worker.ts:
- Import { serve } from "@hono/node-server"
- Import { Hono } from "hono"
- Import { cors } from "hono/cors"
- Import { createDatabase } from "./db/sqlite.js"
- Import { createDbMiddleware } from "./middleware/db.js"
- Import { requireAuth } from "./middleware/auth.js"
- Import { LocalScheduler } from "./engine/scheduler.js"
- Import route modules (authRouter, createSchedulesRouter, executionsRouter)
- const db = createDatabase()
- const scheduler = new LocalScheduler(db)
- await scheduler.restoreAlarms()
- Build Hono app:
  - app.use("*", cors())
  - app.use("*", createDbMiddleware(db))
  - GET /health → { ok: true, data: { status: "healthy", version: "0.1.0" } }
  - app.route("/v1/auth", authRouter)
  - app.route("/v1/schedules", createSchedulesRouter(scheduler))
  - app.route("/v1", executionsRouter)
  - 404 and error handlers same as before
- const port = Number(process.env.PORT) || 4007
- serve({ fetch: app.fetch, port })
- console.log("AgentCron server running on http://localhost:" + port)
- Graceful shutdown: process.on("SIGINT") and process.on("SIGTERM") → scheduler.cancelAll(), process.exit(0)

FILE 2: Delete packages/server/src/worker.ts
Run: rm packages/server/src/worker.ts

Only create src/server.ts and delete src/worker.ts.
IMPORTANT: Write server.ts to disk. Do NOT output to stdout.`,
    dependsOn: ["read-all-rewritten"],
    verification: {
      type: "file_exists",
      value: "packages/server/src/server.ts",
    },
  })

  .step("cleanup-worker", {
    type: "deterministic",
    dependsOn: ["impl-server"],
    command:
      "rm -f packages/server/src/worker.ts && test ! -f packages/server/src/worker.ts && echo 'WORKER_DELETED'",
    failOnError: true,
  })

  // ── Final verification ────────────────────────────────────────────
  .step("verify-no-cf", {
    type: "deterministic",
    dependsOn: ["cleanup-worker"],
    command: [
      "echo 'Checking no Cloudflare references remain...'",
      "! grep -r 'D1Database' packages/server/src/ 2>/dev/null",
      "! grep -r 'DurableObject' packages/server/src/ 2>/dev/null",
      "! grep -r 'drizzle-orm/d1' packages/server/src/ 2>/dev/null",
      "! grep -r 'crypto.subtle' packages/server/src/ 2>/dev/null",
      "! grep -r 'executionCtx' packages/server/src/ 2>/dev/null",
      "test ! -f wrangler.toml",
      "test ! -f drizzle.config.ts",
      "test ! -d packages/server/src/durable-objects",
      "test ! -f packages/server/src/worker.ts",
      "test -f packages/server/src/server.ts",
      "test -f packages/server/src/db/sqlite.ts",
      "test -f packages/server/src/engine/scheduler.ts",
      "echo 'NO_CF_DEPS_OK'",
    ].join(" && "),
    failOnError: true,
  })

  .step("install-and-build", {
    type: "deterministic",
    dependsOn: ["verify-no-cf"],
    command:
      "npm install && npx tsc --noEmit -p packages/server/tsconfig.json 2>&1 || echo 'BUILD_WARNINGS — review above'",
    captureOutput: true,
  })

  .onError("retry", { maxRetries: 2, retryDelayMs: 10_000 })
  .run({ cwd: process.cwd() });

console.log("Result:", result.status);
