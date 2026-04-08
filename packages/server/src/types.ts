import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "./db/schema.js";

export interface Env {
  DB: D1Database;
  SCHEDULER_DO: DurableObjectNamespace;
  ENVIRONMENT: string;
}

export type Database = DrizzleD1Database<typeof schema>;

export interface AuthContext {
  apiKeyId: string;
}

// Extend Hono context
declare module "hono" {
  interface ContextVariableMap {
    db: Database;
    auth: AuthContext;
  }
}
