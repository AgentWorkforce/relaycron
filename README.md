# AgentCron

A scheduling service for AI agents. Create schedules with payloads that get delivered via webhook POST or WebSocket at specified times or cron intervals.

## Project Structure

Turbo monorepo with npm workspaces:

```
packages/
  types/    - Shared Zod schemas and TypeScript types (@agentcron/types)
  server/   - Cloudflare Worker API with Hono.js (@agentcron/server)
  sdk/      - TypeScript SDK for consumers (@agentcron/sdk)
```

## Local Development

### Prerequisites

- Node.js >= 18
- npm
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (installed as a dev dependency)

### Setup

```bash
# Install dependencies
npm install

# Generate database migrations (if schema changed)
npm run db:generate

# Apply migrations to local D1 database
npm run db:migrate

# Start the local dev server
npm run dev
```

The dev server runs at `http://localhost:8787` using Wrangler's local mode with a local D1 SQLite database and Durable Object emulation.

### Create an API Key (local)

```bash
curl -X POST http://localhost:8787/v1/auth/keys \
  -H "Content-Type: application/json" \
  -d '{"name": "local-dev"}'
```

Save the `api_key` from the response (starts with `ac_`). It cannot be retrieved again.

### Create a Schedule (local)

```bash
curl -X POST http://localhost:8787/v1/schedules \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ac_YOUR_KEY_HERE" \
  -d '{
    "name": "test-schedule",
    "schedule_type": "cron",
    "cron_expression": "* * * * *",
    "payload": {"message": "hello"},
    "transport": {
      "type": "webhook",
      "url": "https://httpbin.org/post"
    }
  }'
```

### Build

```bash
npm run build    # Build all packages
```

### Deploy

```bash
npm run deploy              # Deploy to default environment
npm run deploy:staging      # Deploy to staging
npm run deploy:production   # Deploy to production
```

## SDK Usage

```bash
npm install @agentcron/sdk
```

```typescript
import { AgentCron } from "@agentcron/sdk";

const cron = new AgentCron({ apiKey: "ac_..." });

// One-time schedule
await cron.createSchedule({
  name: "deploy-reminder",
  schedule_type: "once",
  scheduled_at: "2025-01-15T09:00:00Z",
  payload: { message: "Time to deploy" },
  transport: {
    type: "webhook",
    url: "https://my-agent.example.com/webhook",
  },
});

// Recurring cron schedule
await cron.createSchedule({
  name: "daily-standup-prep",
  schedule_type: "cron",
  cron_expression: "0 9 * * 1-5",
  timezone: "America/New_York",
  payload: { task: "prepare-standup" },
  transport: {
    type: "webhook",
    url: "https://my-agent.example.com/webhook",
  },
});

// WebSocket delivery
cron.connect({
  onConnected: () => console.log("Connected"),
  onScheduleFired: (msg) => {
    console.log(`${msg.schedule_name} fired:`, msg.payload);
  },
});
```

## API Routes

| Method   | Path                                  | Auth     | Description         |
| -------- | ------------------------------------- | -------- | ------------------- |
| `GET`    | `/health`                             | No       | Health check        |
| `POST`   | `/v1/auth/keys`                      | No       | Create API key      |
| `POST`   | `/v1/schedules`                      | Required | Create schedule     |
| `GET`    | `/v1/schedules`                       | Required | List schedules      |
| `GET`    | `/v1/schedules/:id`                   | Required | Get schedule        |
| `PATCH`  | `/v1/schedules/:id`                   | Required | Update schedule     |
| `DELETE` | `/v1/schedules/:id`                   | Required | Delete schedule     |
| `GET`    | `/v1/schedules/:id/executions`        | Required | List executions     |
| `GET`    | `/v1/schedules/:id/executions/:eid`   | Required | Get execution       |
| `GET`    | `/v1/ws`                              | WS auth  | WebSocket endpoint  |

## License

MIT
