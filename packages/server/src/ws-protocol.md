# RelayCron WebSocket Protocol

This is the M1 websocket contract for proactive-runtime integration. The gateway opens one long-lived outbound websocket to RelayCron at `/v1/ws`, authenticates once, optionally resumes from the last processed event, and can register or cancel schedules over the same connection.

## Connection

URL:

```text
ws://<relaycron-host>/v1/ws
```

Authentication is message-based. The first client frame must be `client_hello`.

## Client Frames

### `client_hello`

Sent immediately after the websocket opens.

```json
{
  "type": "client_hello",
  "api_key": "ac_live_or_test_key",
  "last_event_id": "evt_optional_resume_cursor"
}
```

- `api_key` authenticates the connection.
- `last_event_id` is optional. When omitted, RelayCron starts in live-only mode and does not replay older buffered ticks.
- When `last_event_id` is present, RelayCron replays buffered `tick` events after that event id. If the id is no longer retained in memory, RelayCron replays the retained buffer it still has.

### `register_schedule`

Creates a schedule over the websocket control plane.

```json
{
  "type": "register_schedule",
  "request_id": "req_123",
  "schedule": {
    "name": "support-digest",
    "schedule": {
      "cron": "*/5 * * * *",
      "tz": "America/New_York"
    },
    "payload": {
      "workspace": "support"
    },
    "delivery": {
      "type": "websocket",
      "coalesce_missed_ticks": "fire-once"
    }
  }
}
```

Notes:

- `schedule.schedule` accepts a cron string, `{ "cron": "...", "tz": "..." }`, or `{ "at": "<ISO timestamp>" }`.
- `delivery.type` may be `webhook` or `websocket`.
- `coalesce_missed_ticks: "fire-once"` tells replay to emit only the latest missed tick for that schedule after a disconnect.

### `cancel_schedule`

Cancels and deletes a schedule by id.

```json
{
  "type": "cancel_schedule",
  "request_id": "req_124",
  "schedule_id": "sched_abc123"
}
```

## Server Frames

### `hello_ok`

Sent after a successful `client_hello`.

```json
{
  "type": "hello_ok",
  "agent_id": "api_key_row_id",
  "replayed": 0,
  "heartbeat_interval_ms": 25000
}
```

- `replayed` is the count of retained `tick` events that will be replayed immediately after the hello response.

### `schedule_registered`

```json
{
  "type": "schedule_registered",
  "request_id": "req_123",
  "schedule": {
    "id": "sched_abc123",
    "name": "support-digest",
    "schedule_type": "cron",
    "cron_expression": "*/5 * * * *",
    "timezone": "America/New_York",
    "transport_type": "websocket",
    "next_run_at": "2026-05-11T09:05:00.000Z"
  }
}
```

### `schedule_cancelled`

```json
{
  "type": "schedule_cancelled",
  "request_id": "req_124",
  "schedule_id": "sched_abc123"
}
```

### `tick`

Live cron delivery and replay both use the same frame.

```json
{
  "type": "tick",
  "event_id": "evt_def456",
  "schedule_id": "sched_abc123",
  "schedule_name": "support-digest",
  "scheduled_for": "2026-05-11T09:05:00.000Z",
  "occurred_at": "2026-05-11T09:05:00.413Z",
  "execution_id": "exec_xyz789",
  "payload": {
    "workspace": "support"
  }
}
```

- `scheduled_for` is when the tick was intended to fire.
- `occurred_at` is when RelayCron emitted the delivery event.
- `event_id` is the resume cursor. Persist the last processed id and send it back in the next `client_hello`.

### `heartbeat`

One-way liveness frame emitted on an interval while the socket remains open.

```json
{
  "type": "heartbeat",
  "sent_at": "2026-05-11T09:05:25.000Z"
}
```

### `error`

```json
{
  "type": "error",
  "code": "not_found",
  "message": "Schedule not found",
  "request_id": "req_124"
}
```

## Replay Semantics

- RelayCron retains a bounded in-memory buffer of recent websocket ticks per API key.
- On reconnect, `client_hello.last_event_id` resumes from the next retained event.
- Schedules registered with `coalesce_missed_ticks: "fire-once"` replay only the latest missed tick for that schedule.
- Schedules using the default `coalesce_missed_ticks: "none"` replay every retained tick after the cursor.
