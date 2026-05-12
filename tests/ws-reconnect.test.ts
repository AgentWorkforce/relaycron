import assert from "node:assert/strict";
import test from "node:test";

import { AgentCron } from "../packages/sdk/dist/index.js";

test("waitUntilConnected waits during reconnect backoff", async () => {
  const client = new AgentCron({
    apiKey: "ac_test_key",
    baseUrl: "https://relaycron.test",
  });

  client["shouldReconnect"] = true;
  client["ensureWsReadyPromise"]();

  const previousReady = client["wsReady"];
  previousReady?.catch(() => {});
  client["rejectWsReadyPromise"](new Error("closed"));

  let settled = false;
  const waitPromise = client.waitUntilConnected().then(() => {
    settled = true;
  });

  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });

  assert.equal(settled, false);

  client["resolveWsReadyPromise"]();
  await waitPromise;
  assert.equal(settled, true);
});
