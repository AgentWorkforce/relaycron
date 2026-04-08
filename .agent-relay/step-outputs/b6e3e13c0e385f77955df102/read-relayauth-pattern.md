=== relayauth server.ts ===
import process from "node:process";

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";

import type { AppConfig, AppEnv } from "./env.js";
import auditExport from "./routes/audit-export.js";
import auditQuery from "./routes/audit-query.js";
import auditWebhooks from "./routes/audit-webhooks.js";
import dashboardStats from "./routes/dashboard-stats.js";
import discovery, { apiDiscovery } from "./routes/discovery.js";
import jwks from "./routes/jwks.js";
import identityActivity from "./routes/identity-activity.js";
import identities from "./routes/identities.js";
import policies from "./routes/policies.js";
import roleAssignments from "./routes/role-assignments.js";
import roles from "./routes/roles.js";
import type { AuthStorage } from "./storage/index.js";

const PUBLIC_PATHS = new Set([
  "/health",
  "/.well-known/agent-configuration",
  "/v1/discovery/agent-card",
]);
const BRIDGE_RATE_LIMIT = 30;
const BRIDGE_RATE_WINDOW_MS = 60_000;

export type CreateAppOptions = {
  storage?: AuthStorage;
  config?: Partial<AppConfig>;
  defaultBindings?: Partial<AppConfig>;
  signingKey?: string;
  signingKeyId?: string;
  internalSecret?: string;
  baseUrl?: string;
  allowedOrigins?: string;
};

export type StartServerOptions = {
  port?: number;
  dbPath?: string;
  storage?: AuthStorage;
  config?: Partial<AppConfig>;
};

function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.has(path) || path.startsWith("/.well-known/");
}

function normalizeConfig(options: CreateAppOptions): Partial<AppConfig> {
  return {
    ...(options.defaultBindings ?? {}),
    ...(options.config ?? {}),
    ...(options.signingKey !== undefined ? { SIGNING_KEY: options.signingKey } : {}),
    ...(options.signingKeyId !== undefined ? { SIGNING_KEY_ID: options.signingKeyId } : {}),
    ...(options.internalSecret !== undefined ? { INTERNAL_SECRET: options.internalSecret } : {}),
    ...(options.baseUrl !== undefined ? { BASE_URL: options.baseUrl } : {}),
    ...(options.allowedOrigins !== undefined ? { ALLOWED_ORIGINS: options.allowedOrigins } : {}),
  };
}

function getClientIp(forwardedFor: string | undefined, realIp: string | undefined): string {
  const firstForwarded = forwardedFor?.split(",")[0]?.trim();
  return firstForwarded || realIp?.trim() || "unknown";
}

export function createApp(options: CreateAppOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const bridgeRateMap = new Map<string, { count: number; resetAt: number }>();
  const config = normalizeConfig(options);

  if (Object.keys(config).length > 0) {
    app.use("*", async (c, next) => {
      Object.assign(c.env as Record<string, unknown>, config);
      await next();
    });
  }

  app.use("*", async (c, next) => {
    if (!options.storage) {
      throw new Error("storage is required — use createSqliteStorage (local) or provide a storage adapter");
    }

    c.set("storage", options.storage);
    await next();
  });

  app.use("*", async (c, next) => {
    const allowedRaw = c.env.ALLOWED_ORIGINS;
    const origin = c.req.header("Origin") ?? "";

    if (allowedRaw) {
      const allowed = allowedRaw.split(",").map((value) => value.trim()).filter(Boolean);
      return cors({ origin: allowed })(c, next);
    }

    return cors({ origin: () => (origin === "" ? "*" : "") })(c, next);
  });

=== relayauth package.json ===
{
  "name": "@relayauth/server",
  "version": "0.1.6",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./storage": {
      "types": "./dist/storage/index.d.ts",
      "import": "./dist/storage/index.js"
    },
    "./storage/interface": {
      "types": "./dist/storage/interface.d.ts",
      "import": "./dist/storage/interface.js"
    },
    "./storage/sqlite": {
      "types": "./dist/storage/sqlite.d.ts",
      "import": "./dist/storage/sqlite.js"
    },
    "./node": {
      "types": "./dist/entrypoints/node.d.ts",
      "import": "./dist/entrypoints/node.js"
    }
  },
  "scripts": {
    "dev": "tsx src/server.ts",
    "start": "tsx src/server.ts",
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "node --test --import tsx src/__tests__/*.test.ts",
    "test:e2e": "node --test --import tsx src/__tests__/e2e/*.test.ts"
  },
  "dependencies": {
    "@relayauth/sdk": "*",
    "@relayauth/types": "*",
    "@hono/node-server": "^1.19.11",
    "better-sqlite3": "^11.10.0",
    "hono": "^4"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.12"
  },
  "publishConfig": {
    "access": "public"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/AgentWorkforce/relayauth",
    "directory": "packages/server"
  }
}
