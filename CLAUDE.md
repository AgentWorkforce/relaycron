# AgentCron

A service to schedule work for AI agents. Agents create schedules with payloads that get delivered via webhook POST or WebSocket at specified times or cron intervals.

## Project Structure

Turbo monorepo with npm workspaces:

- `packages/types` - Shared Zod schemas and TypeScript types (`@agentcron/types`)
- `packages/server` - Cloudflare Worker API with Hono.js (`@agentcron/server`)
- `packages/sdk` - TypeScript SDK for consumers (`@agentcron/sdk`)

## Stack

- **Runtime**: Cloudflare Workers
- **Framework**: Hono.js
- **Database**: Cloudflare D1 (SQLite) via Drizzle ORM
- **Scheduling**: Durable Object alarms (one DO per schedule)
- **Build**: Turbo + TypeScript
- **Package manager**: npm

## Key Patterns

- API keys prefixed `ac_`, stored as SHA-256 hashes
- All responses: `{ ok: true, data: ... }` or `{ ok: false, error: { code, message } }`
- Cursor-based pagination on list endpoints
- WebSocket auth: connect, send `{ type: "auth", api_key: "ac_..." }`, receive `auth_ok`
- Durable Object per schedule handles alarm -> execute -> record -> advance

## Commands

```bash
npm install          # Install all dependencies
npm run build        # Build all packages
npm run dev          # Start local dev server (wrangler)
npm run db:generate  # Generate Drizzle migrations
npm run db:migrate   # Apply migrations locally
```

## API Routes

- `POST /v1/auth/keys` - Create API key (no auth)
- `POST /v1/schedules` - Create schedule
- `GET /v1/schedules` - List schedules
- `GET /v1/schedules/:id` - Get schedule
- `PATCH /v1/schedules/:id` - Update schedule
- `DELETE /v1/schedules/:id` - Delete schedule
- `GET /v1/schedules/:id/executions` - List executions
- `GET /v1/schedules/:id/executions/:eid` - Get execution
- `GET /v1/ws` - WebSocket endpoint
