import assert from "node:assert/strict";
import test from "node:test";

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
