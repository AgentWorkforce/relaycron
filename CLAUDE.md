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
<!-- PRPM_MANIFEST_START -->

<skills_system priority="1">
<usage>
When users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.

How to use skills (loaded into main context):
- Use the <path> from the skill entry below
- Invoke: Bash("cat <path>")
- The skill content will load into your current context
- Example: Bash("cat .openskills/backend-architect/SKILL.md")

Usage notes:
- Skills share your context window
- Do not invoke a skill that is already loaded in your context
</usage>

<available_skills>

<skill activation="lazy">
<name>choosing-swarm-patterns</name>
<description>Use when coordinating multiple AI agents and need to pick the right orchestration pattern - covers 10 patterns (fan-out, pipeline, hub-spoke, consensus, mesh, handoff, cascade, dag, debate, hierarchical) with decision framework and reflection protocol</description>
<path>.openskills/choosing-swarm-patterns/SKILL.md</path>
</skill>

<skill activation="lazy">
<name>writing-agent-relay-workflows</name>
<description>Use when building multi-agent workflows with the relay broker-sdk - covers the WorkflowBuilder API, DAG step dependencies, agent definitions, step output chaining via {{steps.X.output}}, verification gates, dedicated channels, swarm patterns, error handling, and event listeners</description>
<path>.openskills/writing-agent-relay-workflows/SKILL.md</path>
</skill>

</available_skills>
</skills_system>

<!-- PRPM_MANIFEST_END -->
