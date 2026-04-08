import { workflow } from "@agent-relay/sdk/workflows";

/**
 * Workflow: Create packages/local — standalone Node.js server for AgentCron
 *
 * The existing packages/server runs on Cloudflare Workers (D1, Durable Objects).
 * This creates a local-first OSS version that runs with:
 *   - Hono + @hono/node-server (like relayauth)
 *   - better-sqlite3 for storage (instead of D1)
 *   - Node.js setTimeout-based scheduler (instead of Durable Object alarms)
 *   - Node.js crypto (instead of crypto.subtle)
 *   - Same API surface, same routes, same @agentcron/types
 *
 * Reference: packages/server (Cloudflare version) for the route logic
 * Reference: relayauth packages/server for the local Hono + better-sqlite3 pattern
 */

const result = await workflow("001-local-server")
  .description("Create packages/local — OSS Node.js server with better-sqlite3")
  .pattern("dag")
  .channel("wf-local-server")
  .maxConcurrency(4)
  .timeout(3_600_000)

  .agent("lead", {
    cli: "claude",
    role: "Architect — plans the local server, reviews output",
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
    role: "Implements server entry point and tests",
    retries: 2,
  })

  // ── Read all source material ─────────────────────────────────────
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

  .step("read-monorepo-config", {
    type: "deterministic",
    command: [
      "cat package.json",
      "echo '---'",
      "cat tsconfig.base.json",
      "echo '---'",
      "cat packages/types/package.json",
    ].join(" && "),
    captureOutput: true,
  })

  // ── Plan ──────────────────────────────────────────────────────────
  .step("plan", {
    agent: "lead",
    task: `Design packages/local — a standalone Node.js server for AgentCron that has zero Cloudflare dependencies.

EXISTING CLOUDFLARE SERVER (what we're porting from):
{{steps.read-cf-server.output}}

{{steps.read-cf-routes.output}}

{{steps.read-cf-engine.output}}

RELAYAUTH PATTERN (how the local server should look):
{{steps.read-relayauth-pattern.output}}

MONOREPO CONFIG:
{{steps.read-monorepo-config.output}}

Design packages/local/ with these files:

1. package.json — @agentcron/local, deps: hono, @hono/node-server, better-sqlite3, drizzle-orm, cron-parser, nanoid, @agentcron/types. DevDeps: @types/better-sqlite3, tsx, typescript.
   Scripts: start (tsx src/server.ts), dev (tsx watch src/server.ts), build (tsc).
2. tsconfig.json — extends ../../tsconfig.base.json
3. src/server.ts — Hono app + @hono/node-server serve(). Port from PORT env or 4007. Auto-inits DB on startup.
4. src/db/sqlite.ts — better-sqlite3 wrapper. Opens .agentcron/agentcron.db (configurable via AGENTCRON_DB_PATH). Auto-creates tables matching the existing schema (api_keys, schedules, executions) with WAL mode. Exports a function that returns a drizzle instance using drizzle-orm/better-sqlite3.
5. src/db/schema.ts — can reuse the existing schema from packages/server verbatim (it's pure drizzle-orm/sqlite-core, no CF deps).
6. src/middleware/db.ts — creates drizzle instance from better-sqlite3, sets on context.
7. src/middleware/auth.ts — same logic but uses Node.js crypto.createHash('sha256') instead of crypto.subtle. Removes c.executionCtx.waitUntil (just await the update).
8. src/routes/auth.ts — same logic, no changes needed (no CF deps).
9. src/routes/schedules.ts — same logic but replace all Durable Object calls (SCHEDULER_DO) with a local scheduler import. When creating/updating/deleting a schedule, call scheduler.setAlarm(id, runAt) or scheduler.cancelAlarm(id) instead.
10. src/routes/executions.ts — same logic verbatim (no CF deps).
11. src/engine/cron.ts — same (no CF deps, already portable).
12. src/engine/executor.ts — same logic (uses standard fetch, already portable).
13. src/engine/scheduler.ts — NEW. Replaces Durable Object alarms with in-process setTimeout. Maintains a Map<scheduleId, NodeJS.Timeout>. Methods: setAlarm(id, runAt, callback), cancelAlarm(id), cancelAll(). On alarm fire: loads schedule from DB, executes webhook, records execution, advances schedule, sets next alarm if recurring. This is the key replacement for the SchedulerDO.
14. src/types.ts — local version: Env has no CF bindings. Database type uses drizzle-orm/better-sqlite3 instead of drizzle-orm/d1.

Output the exact file list, key interfaces, and what changes from the CF version in each file. End with PLAN_COMPLETE.`,
    dependsOn: [
      "read-cf-server",
      "read-cf-routes",
      "read-cf-engine",
      "read-relayauth-pattern",
      "read-monorepo-config",
    ],
    verification: { type: "output_contains", value: "PLAN_COMPLETE" },
  })

  // ── Scaffold ──────────────────────────────────────────────────────
  .step("scaffold", {
    agent: "worker-3",
    task: `Create the package scaffold for packages/local/.

Plan:
{{steps.plan.output}}

Create these files:

1. packages/local/package.json:
{
  "name": "@agentcron/local",
  "version": "0.1.0",
  "description": "Standalone local Node.js server for AgentCron",
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
    "directory": "packages/local"
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

2. packages/local/tsconfig.json — extends ../../tsconfig.base.json, outDir: dist, rootDir: src, declaration: true, include: ["src"].

3. packages/local/src/types.ts:
Import BetterSqlite3Database from drizzle-orm/better-sqlite3.
Export interface LocalEnv { ENVIRONMENT: string; }
Export type Database = BetterSqlite3Database<typeof schema>;
Export interface AuthContext { apiKeyId: string; }
Extend Hono ContextVariableMap with db: Database and auth: AuthContext.

Only create these 3 files. Write to disk.
IMPORTANT: Write the files to disk. Do NOT output to stdout.`,
    dependsOn: ["plan"],
    verification: { type: "file_exists", value: "packages/local/package.json" },
  })

  .step("verify-scaffold", {
    type: "deterministic",
    dependsOn: ["scaffold"],
    command:
      "test -f packages/local/package.json && test -f packages/local/tsconfig.json && test -f packages/local/src/types.ts && echo 'SCAFFOLD_OK'",
    failOnError: true,
  })

  // ── DB + Schema (worker-1) ────────────────────────────────────────
  .step("impl-db", {
    agent: "worker-1",
    task: `Create the database layer for packages/local/.

Plan:
{{steps.plan.output}}

Existing CF schema (reuse this verbatim):
{{steps.read-cf-engine.output}}

Create 2 files:

FILE 1: packages/local/src/db/schema.ts
Copy the schema from packages/server/src/db/schema.ts exactly. It uses drizzle-orm/sqlite-core which has no Cloudflare dependencies — it works with both D1 and better-sqlite3.

FILE 2: packages/local/src/db/sqlite.ts
- Import Database from better-sqlite3 (default import)
- Import { drizzle } from "drizzle-orm/better-sqlite3"
- Import * as schema from "./schema.js"
- Export function createDatabase(dbPath?: string) that:
  - Defaults dbPath to process.env.AGENTCRON_DB_PATH or ".agentcron/agentcron.db"
  - Creates parent directory with fs.mkdirSync(dirname(dbPath), { recursive: true })
  - Opens better-sqlite3 with the path
  - Enables WAL mode: sqlite.pragma("journal_mode = WAL")
  - Enables foreign keys: sqlite.pragma("foreign_keys = ON")
  - Runs CREATE TABLE IF NOT EXISTS for all 3 tables (api_keys, schedules, executions) matching the schema exactly, including indices
  - Returns drizzle(sqlite, { schema })
- Export the type: export type SqliteDatabase = ReturnType<typeof createDatabase>

Only create these 2 files. Write to disk.
IMPORTANT: Write the files to disk. Do NOT output to stdout.`,
    dependsOn: ["plan"],
    verification: { type: "file_exists", value: "packages/local/src/db/sqlite.ts" },
  })

  .step("verify-db", {
    type: "deterministic",
    dependsOn: ["impl-db"],
    command:
      "test -f packages/local/src/db/schema.ts && test -f packages/local/src/db/sqlite.ts && echo 'DB_OK'",
    failOnError: true,
  })

  // ── Scheduler engine (worker-1, after DB) ─────────────────────────
  .step("read-types-file", {
    type: "deterministic",
    dependsOn: ["verify-scaffold"],
    command: "cat packages/local/src/types.ts",
    captureOutput: true,
  })

  .step("impl-scheduler", {
    agent: "worker-1",
    task: `Create the local scheduler engine that replaces Durable Object alarms.

Plan:
{{steps.plan.output}}

CF Durable Object + executor (what we're replacing):
{{steps.read-cf-engine.output}}

Types:
{{steps.read-types-file.output}}

Create 3 files:

FILE 1: packages/local/src/engine/cron.ts
Copy from packages/server/src/engine/cron.ts exactly — it uses cron-parser, no CF deps.

FILE 2: packages/local/src/engine/executor.ts
Copy from packages/server/src/engine/executor.ts but change the Database type import:
- Change: import type { Database } from "../types.js"
  (it already uses standard fetch, drizzle-orm, nanoid — all portable)

FILE 3: packages/local/src/engine/scheduler.ts — NEW, replaces SchedulerDO:
- Import { eq } from "drizzle-orm"
- Import * as schema from "../db/schema.js"
- Import { executeWebhookWithRetry, recordExecution, advanceSchedule } from "./executor.js"
- Import type { Database } from drizzle — accept it as constructor param
- Class LocalScheduler:
  - private timers: Map<string, NodeJS.Timeout>
  - private db: Database (passed in constructor)
  - WEBHOOK_RETRY_CONFIG = { maxAttempts: 3, initialBackoffMs: 1000, backoffMultiplier: 5 }
  - setAlarm(scheduleId: string, runAt: string): void
    - Cancel any existing timer for this id
    - Calculate delay = new Date(runAt).getTime() - Date.now()
    - If delay <= 0, fire immediately via setTimeout(cb, 0)
    - Otherwise setTimeout(cb, delay)
    - Store timer in map
    - The callback calls this.executeSchedule(scheduleId)
  - cancelAlarm(scheduleId: string): void — clear timeout, delete from map
  - cancelAll(): void — clear all timers
  - private async executeSchedule(scheduleId: string): void
    - Same logic as SchedulerDO.alarm(): fetch schedule, check active, execute webhook, record, advance, set next alarm if recurring
  - restoreAlarms(): Promise<void>
    - Query all active schedules with non-null next_run_at
    - Call setAlarm for each one
    - This is called on server startup to resume pending schedules
- Export LocalScheduler

Only create these 3 files. Write to disk.
IMPORTANT: Write the files to disk. Do NOT output to stdout.`,
    dependsOn: ["verify-db", "read-types-file"],
    verification: { type: "file_exists", value: "packages/local/src/engine/scheduler.ts" },
  })

  .step("verify-scheduler", {
    type: "deterministic",
    dependsOn: ["impl-scheduler"],
    command:
      "test -f packages/local/src/engine/cron.ts && test -f packages/local/src/engine/executor.ts && test -f packages/local/src/engine/scheduler.ts && echo 'SCHEDULER_OK'",
    failOnError: true,
  })

  // ── Middleware + Routes (worker-2, after scaffold + db) ───────────
  .step("read-db-file", {
    type: "deterministic",
    dependsOn: ["verify-db"],
    command: "cat packages/local/src/db/sqlite.ts",
    captureOutput: true,
  })

  .step("impl-middleware", {
    agent: "worker-2",
    task: `Create the middleware for packages/local/.

Plan:
{{steps.plan.output}}

CF middleware (what we're porting):
{{steps.read-cf-server.output}}

Local DB module:
{{steps.read-db-file.output}}

Types:
{{steps.read-types-file.output}}

Create 2 files:

FILE 1: packages/local/src/middleware/db.ts
- Import { createMiddleware } from "hono/factory"
- Accept the drizzle database instance via closure (not from env bindings)
- Export function createDbMiddleware(db: Database) that returns a Hono middleware which sets c.set("db", db)

FILE 2: packages/local/src/middleware/auth.ts
- Same logic as the CF version BUT:
  - Replace crypto.subtle.digest with Node.js: import { createHash } from "node:crypto". hashKey becomes: createHash("sha256").update(key).digest("hex") — synchronous, not async.
  - Remove c.executionCtx.waitUntil() — just do a fire-and-forget db update (don't await, just call .then(() => {}) to suppress unhandled rejection)
  - The middleware should accept the db from context (c.get("db")) like before

Only create these 2 files. Write to disk.
IMPORTANT: Write the files to disk. Do NOT output to stdout.`,
    dependsOn: ["verify-scaffold", "read-db-file"],
    verification: { type: "file_exists", value: "packages/local/src/middleware/auth.ts" },
  })

  .step("verify-middleware", {
    type: "deterministic",
    dependsOn: ["impl-middleware"],
    command:
      "test -f packages/local/src/middleware/db.ts && test -f packages/local/src/middleware/auth.ts && echo 'MIDDLEWARE_OK'",
    failOnError: true,
  })

  .step("impl-routes", {
    agent: "worker-2",
    task: `Create the route handlers for packages/local/.

Plan:
{{steps.plan.output}}

CF routes (what we're porting):
{{steps.read-cf-routes.output}}

Create 3 files:

FILE 1: packages/local/src/routes/auth.ts
Copy from CF version. Only change: import paths to local types. The auth route has no CF dependencies.

FILE 2: packages/local/src/routes/schedules.ts
Port from CF version with these changes:
- Remove all SCHEDULER_DO / Durable Object references
- Instead, import LocalScheduler from the engine
- Accept the scheduler instance via closure: export function createSchedulesRouter(scheduler: LocalScheduler)
- Replace DO calls with:
  - scheduler.setAlarm(id, nextRunAt) instead of stub.fetch("/set-alarm", ...)
  - scheduler.cancelAlarm(id) instead of stub.fetch("/cancel-alarm", ...)
- Keep all validation, CRUD, pagination logic identical
- Use the local hashKey (from ../middleware/auth.js) if needed

FILE 3: packages/local/src/routes/executions.ts
Copy from CF version. Only change: import paths to local types. Executions route has no CF dependencies.

Only create these 3 files. Write to disk.
IMPORTANT: Write the files to disk. Do NOT output to stdout.`,
    dependsOn: ["verify-middleware", "verify-scheduler"],
    verification: { type: "file_exists", value: "packages/local/src/routes/schedules.ts" },
  })

  .step("verify-routes", {
    type: "deterministic",
    dependsOn: ["impl-routes"],
    command:
      "test -f packages/local/src/routes/auth.ts && test -f packages/local/src/routes/schedules.ts && test -f packages/local/src/routes/executions.ts && echo 'ROUTES_OK'",
    failOnError: true,
  })

  // ── Server entry point (worker-3, after everything) ───────────────
  .step("read-all-local-src", {
    type: "deterministic",
    dependsOn: ["verify-routes"],
    command: [
      "echo '=== types.ts ==='",
      "cat packages/local/src/types.ts",
      "echo '=== db/sqlite.ts ==='",
      "cat packages/local/src/db/sqlite.ts",
      "echo '=== middleware/db.ts ==='",
      "cat packages/local/src/middleware/db.ts",
      "echo '=== middleware/auth.ts ==='",
      "cat packages/local/src/middleware/auth.ts",
      "echo '=== engine/scheduler.ts ==='",
      "cat packages/local/src/engine/scheduler.ts",
      "echo '=== routes/auth.ts ==='",
      "cat packages/local/src/routes/auth.ts",
      "echo '=== routes/schedules.ts ==='",
      "cat packages/local/src/routes/schedules.ts",
      "echo '=== routes/executions.ts ==='",
      "cat packages/local/src/routes/executions.ts",
    ].join(" && "),
    captureOutput: true,
  })

  .step("impl-server", {
    agent: "worker-3",
    task: `Create the main server entry point at packages/local/src/server.ts.

Here are all the modules that have been created:
{{steps.read-all-local-src.output}}

Reference CF worker.ts:
{{steps.read-cf-server.output}}

Create packages/local/src/server.ts following the relayauth pattern:
- Import { serve } from "@hono/node-server"
- Import { Hono } from "hono"
- Import { cors } from "hono/cors"
- Import { createDatabase } from "./db/sqlite.js"
- Import { createDbMiddleware } from "./middleware/db.js"
- Import { LocalScheduler } from "./engine/scheduler.js"
- Import route modules
- On startup:
  1. Create the database: const db = createDatabase()
  2. Create the scheduler: const scheduler = new LocalScheduler(db)
  3. Restore pending alarms: await scheduler.restoreAlarms()
  4. Build Hono app with cors, db middleware, all routes
  5. Health endpoint at GET /health
  6. Same 404 and error handlers as CF version
  7. serve({ fetch: app.fetch, port: Number(process.env.PORT) || 4007 })
  8. Log: "AgentCron local server running on http://localhost:{port}"
- Graceful shutdown: process.on("SIGINT" / "SIGTERM") => scheduler.cancelAll(), process.exit()
- Auto-start: check import.meta.url === new URL(process.argv[1] ?? "", "file:").href

Only create packages/local/src/server.ts. Only this one file.
IMPORTANT: Write the file to disk. Do NOT output to stdout.`,
    dependsOn: ["read-all-local-src"],
    verification: { type: "file_exists", value: "packages/local/src/server.ts" },
  })

  // ── Final verification ────────────────────────────────────────────
  .step("verify-all-files", {
    type: "deterministic",
    dependsOn: ["impl-server"],
    command: [
      "echo 'Checking all files...'",
      "test -f packages/local/package.json",
      "test -f packages/local/tsconfig.json",
      "test -f packages/local/src/server.ts",
      "test -f packages/local/src/types.ts",
      "test -f packages/local/src/db/schema.ts",
      "test -f packages/local/src/db/sqlite.ts",
      "test -f packages/local/src/middleware/db.ts",
      "test -f packages/local/src/middleware/auth.ts",
      "test -f packages/local/src/routes/auth.ts",
      "test -f packages/local/src/routes/schedules.ts",
      "test -f packages/local/src/routes/executions.ts",
      "test -f packages/local/src/engine/cron.ts",
      "test -f packages/local/src/engine/executor.ts",
      "test -f packages/local/src/engine/scheduler.ts",
      "echo 'ALL_FILES_OK'",
    ].join(" && "),
    failOnError: true,
  })

  .step("install-and-build", {
    type: "deterministic",
    dependsOn: ["verify-all-files"],
    command: "cd packages/local && npm install 2>&1 | tail -5 && npx tsc --noEmit 2>&1 || echo 'BUILD_WARNINGS — review above'",
    captureOutput: true,
  })

  .onError("retry", { maxRetries: 2, retryDelayMs: 10_000 })
  .run({ cwd: process.cwd() });

console.log("Result:", result.status);
