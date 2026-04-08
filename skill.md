# AgentCron - Schedule Work for Agents

AgentCron lets you schedule future work with a payload that gets delivered on a cron schedule or at a specific time. Use it to set reminders, schedule recurring tasks, or defer work.

## Quick Start

Install the SDK:
```bash
npm install @agentcron/sdk
```

### 1. Get an API Key

```bash
curl -X POST https://api.agentcron.dev/v1/auth/keys \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent"}'
```

Save the `api_key` from the response (starts with `ac_`). It cannot be retrieved again.

### 2. Create a Schedule

**One-time schedule (webhook delivery):**
```typescript
import { AgentCron } from "@agentcron/sdk";

const cron = new AgentCron({ apiKey: "ac_..." });

await cron.createSchedule({
  name: "deploy-reminder",
  schedule_type: "once",
  scheduled_at: "2025-01-15T09:00:00Z",
  payload: {
    message: "Time to deploy the new version",
    repo: "myorg/myapp",
    action: "deploy"
  },
  transport: {
    type: "webhook",
    url: "https://my-agent.example.com/webhook"
  }
});
```

**Recurring cron schedule:**
```typescript
await cron.createSchedule({
  name: "daily-standup-prep",
  schedule_type: "cron",
  cron_expression: "0 9 * * 1-5", // 9am weekdays
  timezone: "America/New_York",
  payload: {
    task: "prepare-standup",
    channels: ["#engineering"]
  },
  transport: {
    type: "webhook",
    url: "https://my-agent.example.com/webhook"
  }
});
```

### 3. Receive via WebSocket (Alternative to Webhooks)

Instead of setting up a webhook endpoint, connect via WebSocket to receive payloads in real-time:

```typescript
const cron = new AgentCron({ apiKey: "ac_..." });

// Create a schedule with websocket transport
await cron.createSchedule({
  name: "hourly-check",
  schedule_type: "cron",
  cron_expression: "0 * * * *",
  payload: { task: "check-metrics" },
  transport: { type: "websocket" }
});

// Connect and listen
cron.connect({
  onConnected: () => console.log("Connected to AgentCron"),
  onScheduleFired: (msg) => {
    console.log(`Schedule ${msg.schedule_name} fired!`);
    console.log("Payload:", msg.payload);
    // Handle the scheduled work here
  },
  onDisconnected: (code, reason) => {
    console.log(`Disconnected: ${code} ${reason}`);
  }
});
```

## API Reference

### Base URL
```
https://api.agentcron.dev/v1
```

### Authentication
All requests (except key creation) require a Bearer token:
```
Authorization: Bearer ac_...
```

### Endpoints

#### Schedules

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/schedules` | Create a new schedule |
| `GET` | `/v1/schedules` | List your schedules |
| `GET` | `/v1/schedules/:id` | Get a schedule |
| `PATCH` | `/v1/schedules/:id` | Update a schedule |
| `DELETE` | `/v1/schedules/:id` | Delete a schedule |

#### Executions (Delivery Log)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/schedules/:id/executions` | List executions for a schedule |
| `GET` | `/v1/schedules/:id/executions/:eid` | Get a specific execution |

#### WebSocket

Connect to `wss://api.agentcron.dev/v1/ws` and send an auth message:
```json
{"type": "auth", "api_key": "ac_..."}
```

You'll receive `{"type": "auth_ok"}` on success, then `schedule_fired` messages when your schedules trigger.

### Schedule Object

```json
{
  "id": "abc123",
  "name": "my-schedule",
  "description": "Optional description",
  "schedule_type": "cron",
  "cron_expression": "0 9 * * *",
  "scheduled_at": null,
  "timezone": "UTC",
  "payload": {"any": "json"},
  "transport_type": "webhook",
  "transport_config": {"type": "webhook", "url": "https://..."},
  "status": "active",
  "next_run_at": "2025-01-15T09:00:00Z",
  "last_run_at": "2025-01-14T09:00:00Z",
  "run_count": 14,
  "failure_count": 1,
  "metadata": {"team": "backend"},
  "created_at": "2025-01-01T00:00:00Z",
  "updated_at": "2025-01-14T09:00:00Z"
}
```

### Execution Object

```json
{
  "id": "exec_123",
  "schedule_id": "abc123",
  "started_at": "2025-01-14T09:00:00Z",
  "completed_at": "2025-01-14T09:00:01Z",
  "status": "success",
  "transport_type": "webhook",
  "http_status": 200,
  "response_body": "{\"received\": true}",
  "error": null,
  "duration_ms": 342
}
```

### Cron Expression Format

Standard 5-field cron: `minute hour day-of-month month day-of-week`

| Expression | Description |
|-----------|-------------|
| `* * * * *` | Every minute |
| `0 * * * *` | Every hour |
| `0 9 * * *` | Daily at 9am |
| `0 9 * * 1-5` | Weekdays at 9am |
| `*/15 * * * *` | Every 15 minutes |
| `0 0 1 * *` | First of each month |

### Transport Types

**webhook** - HTTP POST to a URL with your payload as the JSON body. Includes headers:
- `Content-Type: application/json`
- `User-Agent: AgentCron/1.0`
- `X-AgentCron-Delivery: <unique-id>`

**websocket** - Delivered to your connected WebSocket session. Requires an active connection.

### Status Codes

| Status | Meaning |
|--------|---------|
| `active` | Schedule is running |
| `paused` | Schedule is paused (won't fire) |
| `completed` | One-time schedule has executed |
| `expired` | Schedule has been superseded |

### SDK Methods

```typescript
const cron = new AgentCron({ apiKey: "ac_..." });

// Schedules
await cron.createSchedule({...});
await cron.getSchedule("id");
await cron.listSchedules({ limit: 10, status: "active" });
await cron.updateSchedule("id", {...});
await cron.pauseSchedule("id");
await cron.resumeSchedule("id");
await cron.deleteSchedule("id");

// Executions
await cron.listExecutions("schedule_id", { limit: 10 });
await cron.getExecution("schedule_id", "execution_id");

// WebSocket
cron.connect({ onScheduleFired: (msg) => {...} });
cron.disconnect();
```

## Common Patterns

### Agent Self-Scheduling
An agent can schedule follow-up work for itself:
```typescript
await cron.createSchedule({
  name: "follow-up-check",
  schedule_type: "once",
  scheduled_at: new Date(Date.now() + 3600000).toISOString(), // 1 hour
  payload: {
    context: "Check if PR #42 was merged",
    original_task_id: "task-123"
  },
  transport: {
    type: "webhook",
    url: "https://my-agent.example.com/webhook"
  }
});
```

### Monitoring Schedule Health
Check execution history for failures:
```typescript
const { data: execs } = await cron.listExecutions(scheduleId, {
  status: "failure",
  limit: 5
});
if (execs.length > 0) {
  console.log(`${execs.length} recent failures for schedule ${scheduleId}`);
}
```
