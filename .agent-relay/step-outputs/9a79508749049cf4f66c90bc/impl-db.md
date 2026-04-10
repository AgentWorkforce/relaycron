## Summary

Created `packages/server/src/db/sqlite.ts` with the following:

- **Imports**: `better-sqlite3`, `drizzle-orm/better-sqlite3`, schema, `mkdirSync`, `dirname`
- **`createDatabase(dbPath?)`** function that:
  - Defaults to `process.env.RELAYCRON_DB_PATH` or `.relaycron/relaycron.db`
  - Creates parent directory with `mkdirSync(..., { recursive: true })`
  - Opens better-sqlite3 with WAL mode and foreign keys ON
  - Creates all 3 tables with `CREATE TABLE IF NOT EXISTS`:
    - **api_keys**: id, name, key_hash, key_prefix, created_at, last_used_at
    - **schedules**: all 18 columns matching schema.ts, with CHECK constraints for enums, CASCADE foreign key to api_keys, plus 3 indices (api_key_id, status, next_run_at)
    - **executions**: all 10 columns matching schema.ts, with CHECK constraints for enums, CASCADE foreign key to schedules, plus 2 indices (schedule_id, started_at)
  - Returns `drizzle(sqlite, { schema })`

No existing files were modified.
