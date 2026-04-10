import { createMiddleware } from "hono/factory";
import type { Database } from "../types.js";

export function createDbMiddleware(db: Database) {
  return createMiddleware(async (c, next) => {
    c.set("db", db);
    await next();
  });
}
