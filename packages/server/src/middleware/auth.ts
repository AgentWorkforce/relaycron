import { createMiddleware } from "hono/factory";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { apiKeys } from "../db/schema.js";

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
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

  const keyHash = hashKey(token);
  const db = c.get("db");
  const [key] = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.key_hash, keyHash))
    .limit(1);

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
