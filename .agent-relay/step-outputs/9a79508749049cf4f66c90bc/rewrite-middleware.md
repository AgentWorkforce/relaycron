## Summary

Rewrote both middleware files to remove Cloudflare dependencies:

**`packages/server/src/middleware/db.ts`**:
- Removed `drizzle-orm/d1` import and `Env` Bindings type
- Replaced singleton `dbMiddleware` with `createDbMiddleware(db: Database)` factory that accepts an already-constructed `Database` instance and sets it on the Hono context

**`packages/server/src/middleware/auth.ts`**:
- Replaced `crypto.subtle.digest` (Web Crypto / CF Workers API) with `node:crypto`'s `createHash`
- `hashKey` is now synchronous: `createHash("sha256").update(key).digest("hex")`
- Removed `Bindings: Env` type parameter from `createMiddleware`
- Replaced `c.executionCtx.waitUntil(...)` with `.then(() => {}).catch(() => {})` fire-and-forget pattern for the `last_used_at` update
- `hashKey` is a named export (no longer wrapped in `async`)
