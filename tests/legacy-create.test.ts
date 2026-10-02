import assert from "node:assert/strict";
import test from "node:test";

// Imports the built output; the root `npm test` script runs `turbo build`
// first, so dist is fresh.
import {
  createScheduleRecord,
  parseScheduleRequest,
} from "../packages/server/dist/lib/schedules.js";

test("legacy create request without payload stores an empty object payload", async () => {
  const parsed = parseScheduleRequest({
    name: "legacy-no-payload",
    schedule_type: "cron",
    cron_expression: "*/5 * * * *",
    transport: { type: "websocket" },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.data.payload, {});

  const inserted: Array<Record<string, unknown>> = [];
  const fakeDb = {
    insert() {
      return {
        values: async (row: Record<string, unknown>) => {
          inserted.push(row);
        },
      };
    },
  };
  const alarms: string[] = [];
  const fakeScheduler = {
    setAlarm(id: string) {
      alarms.push(id);
    },
    cancelAlarm() {},
  };

  const record = await createScheduleRecord(
    fakeDb as never,
    fakeScheduler,
    "key_legacy",
    parsed.data
  );

  assert.equal(inserted.length, 1);
  assert.equal(inserted[0]?.payload, "{}");
  assert.equal(typeof record.payload, "string");
  assert.deepEqual(alarms, [record.id]);
});

test("legacy create request preserves an explicit null payload", async () => {
  const parsed = parseScheduleRequest({
    name: "legacy-null-payload",
    schedule_type: "cron",
    cron_expression: "*/5 * * * *",
    payload: null,
    transport: { type: "websocket" },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.data.payload, null);

  const inserted: Array<Record<string, unknown>> = [];
  const fakeDb = {
    insert() {
      return {
        values: async (row: Record<string, unknown>) => {
          inserted.push(row);
        },
      };
    },
  };

  await createScheduleRecord(
    fakeDb as never,
    { setAlarm() {}, cancelAlarm() {} },
    "key_legacy",
    parsed.data
  );

  assert.equal(inserted.length, 1);
  assert.equal(inserted[0]?.payload, "null");
});
