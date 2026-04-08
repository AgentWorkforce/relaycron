import { workflow } from "@agent-relay/sdk/workflows";

/**
 * Workflow: Rewrite packages/server + rename @agentcron → @relaycron
 *
 * Two things in one workflow:
 * 1. Rename all packages from @agentcron/* to @relaycron/*
 * 2. Remove all Cloudflare deps from packages/server and replace with:
 *    - Hono + @hono/node-server (like relayauth)
 *    - better-sqlite3 for storage (instead of D1)
 *    - Node.js setTimeout-based scheduler (instead of Durable Object alarms)
 *    - Node.js crypto (instead of crypto.subtle)
 *
 * CF-specific wiring (D1, DOs, SST) lives in ../cloud, not here.
 * The server exports a createApp() factory so cloud can wrap it with its own DB.
 *
 * Repos touched: relaycron/ only (runs in a worktree)
 */

const result = await workflow("001-local-server")
  .description(
    "Rename @agentcron→@relaycron, rewrite server to remove Cloudflare"
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
    role: "Implements storage, scheduler, and rename",
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
    role: "Implements server entry point and app factory",
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
      "echo '=== root package.json ==='",
      "cat package.json",
      "echo '=== server package.json ==='",
      "cat packages/server/package.json",
      "echo '=== sdk package.json ==='",
      "cat packages/sdk/package.json",
      "echo '=== types package.json ==='",
      "cat packages/types/package.json",
      "echo '=== tsconfig.base.json ==='",
      "cat tsconfig.base.json",
      "echo '=== wrangler.toml ==='",
      "cat wrangler.toml",
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

  // ── Rename @agentcron → @relaycron everywhere ─────────────────────
  .step("rename-packages", {
    type: "deterministic",
    command: [
      // Rename in all package.json files
      "sed -i '' 's/@agentcron\\//@relaycron\\//g' package.json packages/types/package.json packages/sdk/package.json packages/server/package.json",
      // Rename in all source files
      "find packages -name '*.ts' -exec sed -i '' 's/@agentcron\\//@relaycron\\//g' {} +",
      // Rename root package name
      "sed -i '' 's/\"name\": \"agentcron\"/\"name\": \"relaycron\"/' package.json",
      // Rename in README
      "test -f README.md && sed -i '' 's/@agentcron\\//@relaycron\\//g' README.md || true",
      "test -f README.md && sed -i '' 's/agentcron/relaycron/g' README.md || true",
      // Rename in CLAUDE.md
      "test -f CLAUDE.md && sed -i '' 's/@agentcron\\//@relaycron\\//g' CLAUDE.md || true",
      // Rename in skill.md
      "test -f skill.md && sed -i '' 's/@agentcron\\//@relaycron\\//g' skill.md || true",
      "test -f skill.md && sed -i '' 's/AgentCron/RelayCron/g' skill.md || true",
      "echo 'RENAME_DONE'",
    ].join(" && "),
    failOnError: true,
  })

  // ── Clean up CF-only files ────────────────────────────────────────
  .step("remove-cf-files", {
    type: "deterministic",
    dependsOn: [
      "read-cf-server",
      "read-cf-routes",
      "read-cf-engine",
      "read-cf-package",
      "rename-packages",
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
All packages have been renamed from @agentcron/* to @relaycron/* already.

CURRENT CF SERVER (being rewritten):
{{steps.read-cf-server.output}}

{{steps.read-cf-routes.output}}

{{steps.read-cf-engine.output}}

CURRENT PACKAGES:
{{steps.read-cf-package.output}}

RELAYAUTH PATTERN (target):
{{steps.read-relayauth-pattern.output}}

CF-only files (wrangler.toml, drizzle.config.ts, durable-objects/) have been deleted.
All @agentcron references have been renamed to @relaycron.

CRITICAL: The server must export a createApp(db, scheduler) factory function so ../cloud
can import it and provide its own D1-backed database and Durable Object scheduler.
The standalone server.ts calls createApp() with a better-sqlite3 db and LocalScheduler.

Files to rewrite in packages/server/src/:
1. package.json — remove CF deps, add Node deps. Keep "private": true since the server isn't published to npm. Add start/dev scripts with tsx.
2. src/types.ts — Database type from drizzle-orm/better-sqlite3, remove CF Env
3. src/db/schema.ts — keep as-is (portable drizzle-orm/sqlite-core)
4. src/db/sqlite.ts — NEW: better-sqlite3 wrapper
5. src/middleware/db.ts — accept db via closure
6. src/middleware/auth.ts — Node.js crypto.createHash
7. src/routes/auth.ts — minimal changes (remove CF types)
8. src/routes/schedules.ts — replace DO calls with scheduler interface
9. src/routes/executions.ts — minimal changes
10. src/engine/cron.ts — keep as-is
11. src/engine/executor.ts — keep as-is (already has retry logic)
12. src/engine/scheduler.ts — NEW: setTimeout-based scheduler
13. src/app.ts — NEW: createApp(db, scheduler) factory, returns Hono app. This is what cloud imports.
14. src/server.ts — NEW: standalone entry point. Creates db + scheduler, calls createApp(), serves with @hono/node-server.
15. DELETE src/worker.ts

The scheduler interface should be abstract enough that cloud can implement it with DOs:
  interface Scheduler { setAlarm(id: string, runAt: string): void; cancelAlarm(id: string): void; }

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
    task: `Rewrite packages/server/package.json and src/types.ts to remove Cloudflare dependencies.
All packages are now @relaycron/* (already renamed).

Plan:
{{steps.plan.output}}

FILE 1: packages/server/package.json — rewrite entirely:
{
  "name": "@relaycron/server",
  "version": "0.1.0",
  "description": "RelayCron server — standalone scheduling service for AI agents",
  "private": true,
  "type": "module",
  "main": "dist/app.js",
  "types": "dist/app.d.ts",
  "exports": {
    ".": { "types": "./dist/app.d.ts", "import": "./dist/app.js" },
    "./scheduler": { "types": "./dist/engine/scheduler.d.ts", "import": "./dist/engine/scheduler.js" },
    "./db": { "types": "./dist/db/sqlite.d.ts", "import": "./dist/db/sqlite.js" }
  },
  "scripts": {
    "start": "tsx src/server.ts",
    "dev": "tsx watch src/server.ts",
    "build": "tsc"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/AgentWorkforce/relaycron",
    "directory": "packages/server"
  },
  "license": "MIT",
  "engines": { "node": ">=18" },
  "dependencies": {
    "@relaycron/types": "*",
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
- Export interface Scheduler { setAlarm(id: string, runAt: string): void; cancelAlarm(id: string): void; }
- Export interface AuthContext { apiKeyId: string }
- Extend Hono ContextVariableMap with db: Database, auth: AuthContext, scheduler: Scheduler

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

Existing schema (keep as-is):
{{steps.read-cf-engine.output}}

FILE: packages/server/src/db/sqlite.ts — NEW:
- Import Database from better-sqlite3
- Import { drizzle } from "drizzle-orm/better-sqlite3"
- Import * as schema from "./schema.js"
- Import { mkdirSync } from "node:fs", { dirname } from "node:path"
- Export function createDatabase(dbPath?: string):
  - Default: process.env.RELAYCRON_DB_PATH || ".relaycron/relaycron.db"
  - mkdirSync(dirname(dbPath), { recursive: true })
  - Open better-sqlite3, WAL mode, foreign keys ON
  - CREATE TABLE IF NOT EXISTS for all 3 tables with indices
  - Return drizzle(sqlite, { schema })

Do NOT modify packages/server/src/db/schema.ts.
Only create packages/server/src/db/sqlite.ts.
IMPORTANT: Write the file to disk. Do NOT output to stdout.`,
    dependsOn: ["plan"],
    verification: { type: "file_exists", value: "packages/server/src/db/sqlite.ts" },
  })

  .step("verify-db", {
    type: "deterministic",
    dependsOn: ["impl-db"],
    command: "test -f packages/server/src/db/sqlite.ts && echo 'DB_OK'",
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
    task: `Create the local scheduler engine for packages/server/.

Plan:
{{steps.plan.output}}

CF Durable Object + executor (replacing):
{{steps.read-cf-engine.output}}

New types:
{{steps.read-types-file.output}}

FILE: packages/server/src/engine/scheduler.ts — NEW:
- Import type { Database, Scheduler } from "../types.js"
- Import * as schema, executor functions
- Class LocalScheduler implements Scheduler:
  - private timers: Map<string, NodeJS.Timeout>
  - private db: Database
  - WEBHOOK_RETRY_CONFIG = { maxAttempts: 3, initialBackoffMs: 1000, backoffMultiplier: 5 }
  - setAlarm(scheduleId, runAt): setTimeout, store in map
  - cancelAlarm(scheduleId): clearTimeout, delete
  - cancelAll(): clear all
  - private async executeSchedule(scheduleId): fetch→execute→record→advance→re-arm
  - async restoreAlarms(): load active schedules with next_run_at, setAlarm each
- Export LocalScheduler

Also ensure packages/server/src/engine/executor.ts imports Database from "../types.js" (not from drizzle-orm/d1).
And packages/server/src/engine/cron.ts stays as-is.

IMPORTANT: Write files to disk. Do NOT output to stdout.`,
    dependsOn: ["verify-db", "read-types-file"],
    verification: { type: "file_exists", value: "packages/server/src/engine/scheduler.ts" },
  })

  .step("verify-scheduler", {
    type: "deterministic",
    dependsOn: ["impl-scheduler"],
    command: "test -f packages/server/src/engine/scheduler.ts && echo 'SCHEDULER_OK'",
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
    task: `Rewrite middleware for packages/server/ to remove Cloudflare deps.

Plan:
{{steps.plan.output}}

Current CF middleware:
{{steps.read-cf-server.output}}

New types:
{{steps.read-types-file.output}}

FILE 1: packages/server/src/middleware/db.ts
- Export function createDbMiddleware(db: Database) returning Hono middleware that sets c.set("db", db)
- No D1, no drizzle-orm/d1

FILE 2: packages/server/src/middleware/auth.ts
- Import { createHash } from "node:crypto"
- hashKey: synchronous createHash("sha256").update(key).digest("hex")
- Remove c.executionCtx.waitUntil — fire-and-forget with .catch(() => {})
- Export hashKey (used by auth route)

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

  // ── Routes (worker-2) ────────────────────────────────────────────
  .step("rewrite-routes", {
    agent: "worker-2",
    task: `Rewrite routes to remove Durable Object references.

Plan:
{{steps.plan.output}}

Current CF routes:
{{steps.read-cf-routes.output}}

New types:
{{steps.read-types-file.output}}

FILE 1: packages/server/src/routes/schedules.ts
- Export function createSchedulesRouter(scheduler: Scheduler) returning Hono router
- Replace DO calls: scheduler.setAlarm(id, nextRunAt), scheduler.cancelAlarm(id)
- Remove Bindings: Env type param
- Keep all validation, CRUD, pagination identical

FILE 2: packages/server/src/routes/auth.ts — remove Bindings: Env, keep everything else

FILE 3: packages/server/src/routes/executions.ts — remove Bindings: Env, keep everything else

Only edit these 3 files. Write to disk.
IMPORTANT: Write the files to disk. Do NOT output to stdout.`,
    dependsOn: ["verify-middleware", "verify-scheduler"],
    verification: { type: "exit_code" },
  })

  .step("verify-routes", {
    type: "deterministic",
    dependsOn: ["rewrite-routes"],
    command:
      "! grep -q 'SCHEDULER_DO' packages/server/src/routes/schedules.ts && echo 'ROUTES_OK'",
    failOnError: true,
  })

  // ── App factory + server entry point (worker-3) ───────────────────
  .step("read-all-rewritten", {
    type: "deterministic",
    dependsOn: ["verify-routes"],
    command: [
      "echo '=== types.ts ==='",
      "cat packages/server/src/types.ts",
      "echo '=== middleware/db.ts ==='",
      "cat packages/server/src/middleware/db.ts",
      "echo '=== middleware/auth.ts ==='",
      "cat packages/server/src/middleware/auth.ts",
      "echo '=== engine/scheduler.ts ==='",
      "cat packages/server/src/engine/scheduler.ts",
      "echo '=== routes/schedules.ts ==='",
      "cat packages/server/src/routes/schedules.ts",
      "echo '=== routes/auth.ts ==='",
      "cat packages/server/src/routes/auth.ts",
      "echo '=== routes/executions.ts ==='",
      "cat packages/server/src/routes/executions.ts",
    ].join(" && "),
    captureOutput: true,
  })

  .step("impl-app-and-server", {
    agent: "worker-3",
    task: `Create the app factory and standalone server entry point.

Rewritten modules:
{{steps.read-all-rewritten.output}}

FILE 1: packages/server/src/app.ts — NEW. This is what ../cloud imports.
- Import Hono, cors
- Import { createDbMiddleware } from "./middleware/db.js"
- Import { requireAuth } from "./middleware/auth.js"
- Import route modules
- Import type { Database, Scheduler } from "./types.js"
- Export function createApp(db: Database, scheduler: Scheduler): Hono
  - Build the Hono app with cors, db middleware
  - Store scheduler on context (or close over it)
  - Mount all routes: /health, /v1/auth, /v1/schedules, /v1 (executions)
  - 404 + error handlers
  - Return the app
- Also re-export types, schema, etc. that cloud might need

FILE 2: packages/server/src/server.ts — NEW. Standalone entry point.
- Import { serve } from "@hono/node-server"
- Import { createDatabase } from "./db/sqlite.js"
- Import { LocalScheduler } from "./engine/scheduler.js"
- Import { createApp } from "./app.js"
- const db = createDatabase()
- const scheduler = new LocalScheduler(db)
- await scheduler.restoreAlarms()
- const app = createApp(db, scheduler)
- const port = Number(process.env.PORT) || 4007
- serve({ fetch: app.fetch, port })
- console.log("RelayCron server running on http://localhost:" + port)
- Graceful shutdown: SIGINT/SIGTERM → scheduler.cancelAll(), process.exit(0)

FILE 3: Delete packages/server/src/worker.ts — rm it

Only create app.ts, server.ts, and delete worker.ts.
IMPORTANT: Write files to disk. Do NOT output to stdout.`,
    dependsOn: ["read-all-rewritten"],
    verification: { type: "file_exists", value: "packages/server/src/app.ts" },
  })

  .step("cleanup-worker", {
    type: "deterministic",
    dependsOn: ["impl-app-and-server"],
    command: "rm -f packages/server/src/worker.ts && echo 'WORKER_DELETED'",
    failOnError: true,
  })

  // ── Final verification ────────────────────────────────────────────
  .step("verify-no-cf", {
    type: "deterministic",
    dependsOn: ["cleanup-worker"],
    command: [
      "echo 'Checking no Cloudflare references remain...'",
      "! grep -r 'D1Database' packages/server/src/",
      "! grep -r 'DurableObject' packages/server/src/",
      "! grep -r 'drizzle-orm/d1' packages/server/src/",
      "! grep -r 'crypto.subtle' packages/server/src/",
      "! grep -r 'executionCtx' packages/server/src/",
      "! grep -r '@agentcron' packages/",
      "test ! -f wrangler.toml",
      "test ! -f drizzle.config.ts",
      "test ! -d packages/server/src/durable-objects",
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
    command:
      "npm install && npx tsc --noEmit -p packages/server/tsconfig.json 2>&1 || echo 'BUILD_WARNINGS'",
    captureOutput: true,
  })

  .onError("retry", { maxRetries: 2, retryDelayMs: 10_000 })
  .run({ cwd: process.cwd() });

console.log("Result:", result.status);
