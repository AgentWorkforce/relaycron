import { Hono } from "hono";
import { nanoid } from "nanoid";
import { apiKeys } from "../db/schema.js";
import { findApiKey, hashKey, secretsMatch } from "../middleware/auth.js";

export interface AuthRouterOptions {
  /**
   * Operator secret that may mint API keys without an existing key. Used to
   * bootstrap the first key. When unset, only an existing valid `ac_` key can
   * mint new keys, and a fresh database cannot mint any (fail closed).
   */
  adminSecret?: string;
}

function unauthorized(message: string) {
  return {
    ok: false as const,
    error: { code: "unauthorized", message },
  };
}

export function createAuthRouter(options: AuthRouterOptions = {}): Hono {
  const auth = new Hono();
  const adminSecret = options.adminSecret?.trim() || undefined;

  // Create a new API key. Requires `Authorization: Bearer <credential>`, where
  // the credential is either the configured admin secret or an existing valid
  // `ac_` API key. Unauthenticated minting let anyone who could reach the
  // service create keys and schedules (outbound webhook / SSRF abuse).
  auth.post("/keys", async (c) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json(
        unauthorized("Missing or invalid Authorization header"),
        401
      );
    }
    const token = authHeader.slice(7).trim();
    const db = c.get("db");
    const authorized =
      token.length > 0 &&
      ((adminSecret !== undefined && secretsMatch(token, adminSecret)) ||
        (await findApiKey(db, token)) !== undefined);
    if (!authorized) {
      return c.json(unauthorized("Invalid credential"), 401);
    }

    const body = await c.req.json<{ name: string }>().catch(() => null);
    if (!body?.name || typeof body.name !== "string") {
      return c.json(
        {
          ok: false,
          error: { code: "bad_request", message: "name is required" },
        },
        400
      );
    }

    const id = nanoid();
    const rawKey = `ac_${nanoid(32)}`;
    const keyHash = await hashKey(rawKey);
    const keyPrefix = rawKey.slice(0, 10);

    await db.insert(apiKeys).values({
      id,
      name: body.name,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      created_at: new Date().toISOString(),
    });

    return c.json(
      {
        ok: true,
        data: {
          id,
          name: body.name,
          api_key: rawKey,
          key_prefix: keyPrefix,
          created_at: new Date().toISOString(),
          _note: "Save this API key now. It cannot be retrieved again.",
        },
      },
      201
    );
  });

  return auth;
}
