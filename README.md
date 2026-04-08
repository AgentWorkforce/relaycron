# AgentCron

A scheduling service for AI agents. Create schedules with payloads that get delivered via webhook POST or WebSocket at specified times or cron intervals.

## Project Structure

Turbo monorepo with npm workspaces:

```
packages/
  types/    - Shared Zod schemas and TypeScript types (@agentcron/types)
  server/   - Standalone Node.js server with SQLite (@agentcron/server)
  sdk/      - TypeScript SDK for consumers (@agentcron/sdk)
```

## Running Locally

The local server runs as a standalone Node.js process with better-sqlite3 — no Cloudflare, Wrangler, or cloud dependencies required.

### Prerequisites

- Node.js >= 18
- npm

### Setup

```bash
# Install dependencies
npm install

# Start the server
npm start -w packages/server
```

The server runs at `http://localhost:4007` with a SQLite database at `.agentcron/agentcron.db` (auto-created on first run).

Configure with environment variables:
- `PORT` — server port (default: 4007)
- `AGENTCRON_DB_PATH` — database file path (default: `.agentcron/agentcron.db`)

### Create an API Key

```bash
curl -X POST http://localhost:4007/v1/auth/keys \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent"}'
```

Save the `api_key` from the response (starts with `ac_`). It cannot be retrieved again.

### Create a Schedule

```bash
curl -X POST http://localhost:4007/v1/schedules \
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
