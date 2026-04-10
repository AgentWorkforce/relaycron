## Summary

**Two files rewritten successfully:**

### `packages/server/package.json`
- **Added**: `main` (dist/app.js), `types` (dist/app.d.ts), `exports` map (`.`, `./scheduler`, `./db`)
- **Scripts**: `start` → `tsx src/server.ts`, `dev` → `tsx watch src/server.ts`, `build` → `tsc`
- **New deps**: `@hono/node-server ^1.13.0`, `better-sqlite3 ^11.0.0`
- **New devDeps**: `@types/better-sqlite3 ^7.6.0`, `tsx ^4.0.0`
- **Removed**: `wrangler`, `@cloudflare/workers-types`, `drizzle-kit`, all deploy scripts

### `packages/server/src/types.ts`
- **Changed**: `DrizzleD1Database` → `BetterSQLite3Database` (from `drizzle-orm/better-sqlite3`)
- **Removed**: `Env` interface (D1Database, DurableObjectNamespace references)
- **Added**: `Scheduler` interface with `setAlarm(id, runAt)` and `cancelAlarm(id)` methods
- **Kept**: `Database` type alias, `AuthContext` interface, Hono `ContextVariableMap` augmentation
