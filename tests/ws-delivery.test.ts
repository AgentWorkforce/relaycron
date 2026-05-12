import assert from "node:assert/strict";
import test from "node:test";

import { RelaycronWsGateway } from "../packages/server/dist/ws-gateway.js";

class FakeSocket {
  readyState = 1;
  readonly sent: unknown[] = [];
  closed: { code: number; reason: string } | null = null;

  send(payload: string): void {
    this.sent.push(JSON.parse(payload));
  }

  close(code: number, reason: string): void {
    this.readyState = 3;
    this.closed = { code, reason };
  }
}

test("register -> tick -> deliver works over the in-memory websocket gateway", async (t) => {
  const storedKey = {
    id: "key_ws_delivery",
    rawKey: "ac_ws_delivery_key",
  };

  const fakeDb = {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                limit: async () => [{ id: storedKey.id }],
                orderBy() {
                  return {
                    all: async () => [],
                  };
                },
              };
            },
          };
        },
      };
    },
    insert() {
      return {
        values: async () => {},
      };
    },
  };

  const fakeScheduler = {
    setAlarm() {},
    cancelAlarm() {},
  };

  const wsGateway = new RelaycronWsGateway(fakeDb as never, fakeScheduler);
  const socket = new FakeSocket();
  const session = {
    id: "sess_ws_delivery",
    ws: socket,
    apiKeyId: null as string | null,
    heartbeatTimer: null as ReturnType<typeof setInterval> | null,
  };
  wsGateway["sessions"].set(session.id, session);
  t.after(() => {
    if (session.heartbeatTimer) {
      clearInterval(session.heartbeatTimer);
    }
  });

  await wsGateway["handleClientHello"](session as never, {
    type: "client_hello",
    api_key: storedKey.rawKey,
  });

  assert.equal(session.apiKeyId, storedKey.id);
  assert.deepEqual(socket.sent[0], {
    type: "hello_ok",
    agent_id: storedKey.id,
    replayed: 0,
    heartbeat_interval_ms: 25_000,
  });

  const schedule = {
    id: "sched_ws_delivery",
    name: "oneshot websocket delivery",
    payload: { source: "test" },
  };
  const scheduledFor = new Date(Date.now() + 25).toISOString();

  await new Promise<void>((resolve) => {
    setTimeout(() => {
      wsGateway.deliverTick({
        apiKeyId: storedKey.id,
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        executionId: "exec_ws_delivery",
        payload: schedule.payload,
        scheduledFor,
        occurredAt: new Date().toISOString(),
        coalesceMissedTicks: "fire-once",
      });
      resolve();
    }, Math.max(0, Date.parse(scheduledFor) - Date.now()));
  });

  const tickMessage = socket.sent.find(
    (message): message is {
      type: "tick";
      schedule_id: string;
      scheduled_for: string;
    } =>
      typeof message === "object"
      && message !== null
      && (message as { type?: unknown }).type === "tick",
  );

  assert.ok(
    tickMessage,
    `expected a tick message after scheduling, saw ${JSON.stringify(socket.sent)}`,
  );
  assert.equal(tickMessage.schedule_id, schedule.id);
  assert.equal(tickMessage.scheduled_for, scheduledFor);
});

test("malformed client_hello frames are rejected without throwing", async () => {
  const fakeDb = {
    select() {
      throw new Error("api key lookup should not run for malformed hello");
    },
  };

  const fakeScheduler = {
    setAlarm() {},
    cancelAlarm() {},
  };

  const wsGateway = new RelaycronWsGateway(fakeDb as never, fakeScheduler);
  const socket = new FakeSocket();
  const session = {
    id: "sess_malformed_hello",
    ws: socket,
    apiKeyId: null as string | null,
    heartbeatTimer: null as ReturnType<typeof setInterval> | null,
  };

  await wsGateway["handleMessage"](
    session as never,
    JSON.stringify({ type: "client_hello" }),
  );

  assert.deepEqual(socket.sent, [
    {
      type: "error",
      code: "unauthorized",
      message: "Invalid API key format",
    },
  ]);
  assert.deepEqual(socket.closed, {
    code: 4003,
    reason: "Unauthorized",
  });
});
