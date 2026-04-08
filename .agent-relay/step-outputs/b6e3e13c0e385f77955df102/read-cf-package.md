=== root package.json ===
{
  "name": "agentcron",
  "version": "0.1.0",
  "private": true,
  "packageManager": "npm@10.9.2",
  "repository": {
    "type": "git",
    "url": "https://github.com/AgentWorkforce/relaycron"
  },
  "license": "MIT",
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "build": "turbo build",
    "dev": "turbo dev",
    "lint": "turbo lint",
    "test": "turbo test",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "wrangler d1 migrations apply agentcron-db --local"
  },
  "devDependencies": {
    "@agent-relay/sdk": "^4.0.5",
    "turbo": "^2.4.0",
    "typescript": "^5.7.0"
  }
}
=== server package.json ===
{
  "name": "@agentcron/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "repository": {
    "type": "git",
    "url": "https://github.com/AgentWorkforce/relaycron",
    "directory": "packages/server"
  },
  "license": "MIT",
  "scripts": {
    "dev": "wrangler dev",
    "build": "tsc",
    "deploy": "wrangler deploy",
    "deploy:staging": "wrangler deploy --env staging",
    "deploy:production": "wrangler deploy --env production"
  },
  "dependencies": {
    "@agentcron/types": "*",
    "drizzle-orm": "^0.38.0",
    "hono": "^4.7.0",
    "cron-parser": "^5.0.0",
    "nanoid": "^5.0.0"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20250214.0",
    "drizzle-kit": "^0.30.0",
    "typescript": "^5.7.0",
    "wrangler": "^3.105.0"
  }
}
=== sdk package.json ===
{
  "name": "@agentcron/sdk",
  "version": "0.1.0",
  "description": "TypeScript SDK for AgentCron — schedule work for AI agents",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "prepublishOnly": "npm run build"
  },
  "publishConfig": {
    "access": "public"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/AgentWorkforce/relaycron",
    "directory": "packages/sdk"
  },
  "license": "MIT",
  "engines": {
    "node": ">=18"
  },
  "dependencies": {
    "@agentcron/types": "*"
  },
  "devDependencies": {
    "typescript": "^5.7.0"
  }
}
=== types package.json ===
{
  "name": "@agentcron/types",
  "version": "0.1.0",
  "description": "Shared Zod schemas and TypeScript types for AgentCron",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "prepublishOnly": "npm run build"
  },
  "publishConfig": {
    "access": "public"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/AgentWorkforce/relaycron",
    "directory": "packages/types"
  },
  "license": "MIT",
  "engines": {
    "node": ">=18"
  },
  "dependencies": {
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0"
  }
}
=== tsconfig.base.json ===
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true
  }
}
=== wrangler.toml ===
name = "agentcron"
main = "packages/server/src/worker.ts"
compatibility_date = "2024-12-01"
compatibility_flags = ["nodejs_compat"]

[triggers]
# Runs every minute to check for due schedules as a fallback
crons = ["* * * * *"]

[[d1_databases]]
binding = "DB"
database_name = "agentcron-db"
database_id = "PLACEHOLDER"
migrations_dir = "packages/server/src/db/migrations"

[[durable_objects.bindings]]
name = "SCHEDULER_DO"
class_name = "SchedulerDO"

[[migrations]]
tag = "v1"
new_classes = ["SchedulerDO"]

[vars]
ENVIRONMENT = "development"

[env.staging]
vars = { ENVIRONMENT = "staging" }

[env.production]
vars = { ENVIRONMENT = "production" }
