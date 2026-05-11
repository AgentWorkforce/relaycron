# RelayCron

A scheduling service for agents. Schedules can deliver to a webhook endpoint or to a long-lived websocket session using the proactive-runtime protocol.

## Project Structure

Turbo monorepo with npm workspaces:

```
packages/
  types/    - Shared Zod schemas and TypeScript types (@relaycron/types)
  server/   - Standalone Node.js server with SQLite (@relaycron/server)
  sdk/      - TypeScript SDK for consumers (@relaycron/sdk)
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

The server runs at `http://localhost:4007` with a SQLite database at `.relaycron/relaycron.db` (auto-created on first run).

Configure with environment variables:
- `PORT` — server port (default: 4007)
- `RELAYCRON_DB_PATH` — database file path (default: `.relaycron/relaycron.db`)

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

### Register a WebSocket Schedule

```bash
curl -X POST http://localhost:4007/v1/schedules \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ac_YOUR_KEY_HERE" \
  -d '{
    "name": "agent-gateway-tick",
    "schedule": { "cron": "*/5 * * * *", "tz": "America/New_York" },
    "payload": { "workspace": "support" },
    "delivery": {
      "type": "websocket",
      "coalesce_missed_ticks": "fire-once"
    }
  }'
```

Then connect a websocket client to `ws://localhost:4007/v1/ws` and send:

```json
{
  "type": "client_hello",
  "api_key": "ac_YOUR_KEY_HERE"
}
```

The server replies with `hello_ok`, then streams `tick` events. Full protocol details live in [`packages/server/src/ws-protocol.md`](packages/server/src/ws-protocol.md).

If you reconnect with `last_event_id`, RelayCron replays retained missed ticks after that cursor. If you omit `last_event_id`, the socket starts in live-only mode and does not replay older buffered ticks.

### Build

```bash
npm run build    # Build all packages
```

## SDK Usage

```bash
npm install @relaycron/sdk
```

```typescript
import { AgentCron } from "@relaycron/sdk";

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

// User-friendly register() API for the proactive runtime contract.
await cron.register({
  name: "proactive-runtime",
  schedule: { cron: "*/5 * * * *", tz: "America/New_York" },
  payload: { workspace: "support" },
  webSocket: { coalesceMissedTicks: "fire-once" },
});

// WebSocket delivery
cron.connect({
  onConnected: (msg) => console.log("Connected", msg.agent_id),
  onHeartbeat: (msg) => console.log("Heartbeat", msg.sent_at),
  onTick: (msg) => {
    console.log(`${msg.schedule_name} fired at ${msg.occurred_at}:`, msg.payload);
  },
});

await cron.waitUntilConnected();

// Register and cancel over the same websocket control plane used for delivery.
const wsSchedule = await cron.registerViaWebSocket({
  name: "support-digest",
  schedule: { cron: "*/5 * * * *", tz: "America/New_York" },
  payload: { workspace: "support" },
  webSocket: { coalesceMissedTicks: "fire-once" },
});

await cron.cancelViaWebSocket(wsSchedule.id);

// Explicit HTTP cancel endpoint for control planes that prefer request/response APIs.
await cron.cancelById(wsSchedule.id);
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
| `POST`   | `/v1/schedules/:id/cancel`            | Required | Cancel schedule     |
| `DELETE` | `/v1/schedules/:id`                   | Required | Delete schedule     |
| `GET`    | `/v1/schedules/:id/executions`        | Required | List executions     |
| `GET`    | `/v1/schedules/:id/executions/:eid`   | Required | Get execution       |
| `GET`    | `/v1/ws`                              | WS auth  | WebSocket endpoint  |

## WebSocket Protocol

RelayCron's websocket protocol is documented in [`packages/server/src/ws-protocol.md`](packages/server/src/ws-protocol.md). The required frames for the proactive runtime M1 integration are:

- `client_hello` for authentication and resume-after-disconnect
- `register_schedule` and `cancel_schedule` for control-plane operations
- `tick` for live cron delivery
- `heartbeat` for connection liveness

The SDK exposes this flow directly via `connect()`, `waitUntilConnected()`, `registerViaWebSocket()`, `cancelViaWebSocket()`, and `cancelById()`.

## License

MIT
