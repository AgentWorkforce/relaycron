All three files edited. Here's a summary of what was done:

**packages/server/src/routes/schedules.ts:**
- Changed from default-exporting a module-level `schedulesRouter` to exporting a factory function `createSchedulesRouter(scheduler: Scheduler)` that returns the router
- Replaced `import type { Env } from "../types.js"` with `import type { Scheduler } from "../types.js"`
- Removed `Hono<{ Bindings: Env }>` → plain `Hono()`
- Replaced 3 Durable Object call sites:
  - Create: `c.env.SCHEDULER_DO.idFromName(id)` + `stub.fetch("/set-alarm"...)` → `scheduler.setAlarm(id, nextRunAt)`
  - Update: `stub.fetch("/set-alarm"...)` / `stub.fetch("/cancel-alarm"...)` → `scheduler.setAlarm(id, nextRunAt)` / `scheduler.cancelAlarm(id)`
  - Delete: `stub.fetch("/cancel-alarm"...)` → `scheduler.cancelAlarm(id)`
- All validation, CRUD, pagination, `formatSchedule`, and `computeNextRunAt` logic preserved identically

**packages/server/src/routes/auth.ts:**
- Removed `import type { Env } from "../types.js"`
- Changed `new Hono<{ Bindings: Env }>()` → `new Hono()`
- All other logic unchanged

**packages/server/src/routes/executions.ts:**
- Removed `import type { Env } from "../types.js"`
- Changed `new Hono<{ Bindings: Env }>()` → `new Hono()`
- All other logic unchanged
