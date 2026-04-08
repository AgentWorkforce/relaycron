**Created 2 files:**

**`packages/server/src/app.ts`** — App factory that cloud/standalone can both import:
- `createApp(db, scheduler)` returns a configured Hono instance
- Applies CORS and DB middleware globally
- Mounts `/health`, `/v1/auth`, `/v1/schedules`, `/v1` (executions) routes
- Includes 404 and global error handlers
- Re-exports `Database` and `Scheduler` types for consumers

**`packages/server/src/server.ts`** — Standalone Node.js entry point:
- Creates SQLite database via `createDatabase()`
- Instantiates `LocalScheduler` and restores existing alarms
- Serves on `PORT` env var or 4007 via `@hono/node-server`
- Graceful shutdown on SIGINT/SIGTERM calls `scheduler.cancelAll()`
