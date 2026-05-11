import assert from "node:assert/strict";
import test from "node:test";

import { AgentCron } from "@relaycron/sdk";

test("deleteSchedule cancels a schedule by id over HTTP", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
    });
    return new Response(JSON.stringify({ ok: true, data: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = new AgentCron({
    apiKey: "ac_test_key",
    baseUrl: "https://relaycron.test",
  });

  await client.deleteSchedule("sched_123");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://relaycron.test/v1/schedules/sched_123");
  assert.equal(calls[0].method, "DELETE");
  assert.equal(calls[0].headers.get("authorization"), "Bearer ac_test_key");
});
