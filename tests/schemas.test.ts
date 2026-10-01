import assert from "node:assert/strict";
import test from "node:test";

// Imports the built output; the root `npm test` script runs `turbo build`
// first, so dist is fresh.
import {
  CreateScheduleRequest,
  ListSchedulesQuery,
  RegisterScheduleRequest,
  UpdateScheduleRequest,
} from "../packages/types/dist/index.js";

test("legacy create request accepts a missing payload", () => {
  const parsed = CreateScheduleRequest.safeParse({
    name: "nightly",
    schedule_type: "cron",
    cron_expression: "0 0 * * *",
    transport: { type: "websocket" },
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.data.payload, undefined);
  assert.equal(parsed.data.timezone, "UTC");
  assert.deepEqual(parsed.data.transport, {
    type: "websocket",
    coalesce_missed_ticks: "none",
  });
});

test("register request applies webhook defaults and string-keyed records", () => {
  const parsed = RegisterScheduleRequest.parse({
    name: "hook",
    schedule: { cron: "*/5 * * * *", tz: "UTC" },
    delivery: {
      type: "webhook",
      url: "https://example.com/hook",
      headers: { authorization: "Bearer x" },
    },
    metadata: { owner: "agent", attempts: 2 },
  });
  assert.deepEqual(parsed.delivery, {
    type: "webhook",
    url: "https://example.com/hook",
    headers: { authorization: "Bearer x" },
    timeout_ms: 10000,
  });
  assert.deepEqual(parsed.metadata, { owner: "agent", attempts: 2 });
});

test("record values are validated", () => {
  const parsed = RegisterScheduleRequest.safeParse({
    name: "hook",
    schedule: "0 0 * * *",
    delivery: {
      type: "webhook",
      url: "https://example.com/hook",
      headers: { "x-count": 1 },
    },
  });
  assert.equal(parsed.success, false);
  if (parsed.success) return;
  assert.deepEqual(parsed.error.issues[0]?.path, [
    "delivery",
    "headers",
    "x-count",
  ]);
});

test("update request leaves omitted fields undefined", () => {
  const parsed = UpdateScheduleRequest.parse({ status: "paused" });
  assert.deepEqual(parsed, { status: "paused" });
});

test("list query coerces and defaults limit", () => {
  assert.equal(ListSchedulesQuery.parse({ limit: "5" }).limit, 5);
  assert.equal(ListSchedulesQuery.parse({}).limit, 20);
  assert.equal(ListSchedulesQuery.safeParse({ limit: "0" }).success, false);
});
