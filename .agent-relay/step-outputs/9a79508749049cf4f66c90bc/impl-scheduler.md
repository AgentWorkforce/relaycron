## Summary

**Created:** `packages/server/src/engine/scheduler.ts`

The `LocalScheduler` class implements the `Scheduler` interface from `types.ts` and replaces Durable Object alarms with Node.js `setTimeout` timers:

- **`setAlarm(scheduleId, runAt)`** — Cancels any existing timer, calculates delay from `runAt`, and sets a `setTimeout`. Overdue alarms fire immediately (`delay <= 0 → setTimeout(cb, 0)`).
- **`cancelAlarm(scheduleId)`** — Clears the timer and removes it from the map.
- **`cancelAll()`** — Clears all active timers.
- **`executeSchedule(scheduleId)`** (private) — Fetches the schedule from DB, checks it's active, executes webhook with retry (3 attempts, 1s initial backoff, 5x multiplier) or records a failure for websocket transport, then calls `advanceSchedule` and re-arms if there's a next run.
- **`restoreAlarms()`** — Queries all active schedules with a `next_run_at` and sets alarms for each. Logs the count.

**No changes needed to `executor.ts`** — it already imports `Database` from `"../types.js"`.

**Type-checked:** No new TypeScript errors introduced. Used `ReturnType<typeof setTimeout>` instead of `NodeJS.Timeout` to avoid a dependency on `@types/node`.
