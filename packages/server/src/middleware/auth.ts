import { createMiddleware } from "hono/factory";
import { createHash, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { apiKeys } from "../db/schema.js";
import type { Database } from "../types.js";

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Constant-time string comparison over SHA-256 digests (length-independent). */
export function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Looks up a raw `ac_` API key; returns the stored row or undefined. */
export async function findApiKey(db: Database, token: string) {
  if (!token.startsWith("ac_")) return undefined;
  const [key] = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.key_hash, hashKey(token)))
    .limit(1);
  return key;
}

export const requireAuth = createMiddleware(async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json(
      {
        ok: false,
        error: {
          code: "unauthorized",
          message: "Missing or invalid Authorization header",
        },
      },
      401
    );
  }

  const token = authHeader.slice(7);
  if (!token.startsWith("ac_")) {
    return c.json(
      {
        ok: false,
        error: { code: "unauthorized", message: "Invalid API key format" },
      },
      401
    );
  }

  const db = c.get("db");
  const key = await findApiKey(db, token);

  if (!key) {
    return c.json(
      {
        ok: false,
        error: { code: "unauthorized", message: "Invalid API key" },
      },
      401
    );
  }

  // Update last_used_at (fire and forget)
  db.update(apiKeys)
    .set({ last_used_at: new Date().toISOString() })
    .where(eq(apiKeys.id, key.id))
    .then(() => {})
    .catch(() => {});

  c.set("auth", { apiKeyId: key.id });
  await next();
});
