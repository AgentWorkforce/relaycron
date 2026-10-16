import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Imports the built output; the root `npm test` script runs `turbo build`
// first, so dist is fresh.
import { createApp, createDatabase } from "../packages/server/dist/index.js";

const ADMIN_SECRET = "test-admin-secret";
const noopScheduler = { setAlarm() {}, cancelAlarm() {} };

function setup(t: test.TestContext, options?: { adminSecret?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "relaycron-auth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = createDatabase(join(dir, "relaycron.db"));
  return createApp(db, noopScheduler, options);
}

function mint(
  app: ReturnType<typeof createApp>,
  authorization?: string,
  body: unknown = { name: "k" }
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authorization) headers.authorization = authorization;
  return app.request("/v1/auth/keys", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

test("POST /v1/auth/keys rejects an unauthenticated request", async (t) => {
  const app = setup(t, { adminSecret: ADMIN_SECRET });
  const res = await mint(app);
  assert.equal(res.status, 401);
  const json = (await res.json()) as { ok: boolean; data?: { api_key?: string } };
  assert.equal(json.ok, false);
  assert.equal(json.data?.api_key, undefined);
});

test("POST /v1/auth/keys fails closed when no admin secret is configured", async (t) => {
  const app = setup(t);
  assert.equal((await mint(app)).status, 401);
  assert.equal((await mint(app, "Bearer ")).status, 401);
  assert.equal((await mint(app, "Bearer anything")).status, 401);
});

test("POST /v1/auth/keys rejects a wrong admin secret and a forged ac_ key", async (t) => {
  const app = setup(t, { adminSecret: ADMIN_SECRET });
  assert.equal((await mint(app, "Bearer wrong-secret")).status, 401);
  assert.equal((await mint(app, `Bearer ${ADMIN_SECRET}x`)).status, 401);
  assert.equal((await mint(app, "Bearer ac_notarealkey000000000000000000000")).status, 401);
  assert.equal((await mint(app, ADMIN_SECRET)).status, 401); // missing Bearer
});

test("POST /v1/auth/keys mints with the admin secret, and the minted key authenticates", async (t) => {
  const app = setup(t, { adminSecret: ADMIN_SECRET });
  const res = await mint(app, `Bearer ${ADMIN_SECRET}`, { name: "bootstrap" });
  assert.equal(res.status, 201);
  const json = (await res.json()) as { ok: boolean; data: { api_key: string } };
  assert.equal(json.ok, true);
  assert.match(json.data.api_key, /^ac_/);

  const list = await app.request("/v1/schedules", {
    headers: { authorization: `Bearer ${json.data.api_key}` },
  });
  assert.equal(list.status, 200);
});

test("POST /v1/auth/keys accepts an existing valid ac_ key (Cloud's caller path)", async (t) => {
  const app = setup(t, { adminSecret: ADMIN_SECRET });
  const first = (await (
    await mint(app, `Bearer ${ADMIN_SECRET}`, { name: "cloud" })
  ).json()) as { data: { api_key: string } };

  const res = await mint(app, `Bearer ${first.data.api_key}`, {
    name: "cloud-workflow-schedule:abc",
  });
  assert.equal(res.status, 201);
  const json = (await res.json()) as { data: { api_key: string } };
  assert.match(json.data.api_key, /^ac_/);
  assert.notEqual(json.data.api_key, first.data.api_key);
});

test("POST /v1/auth/keys still validates the body once authorized", async (t) => {
  const app = setup(t, { adminSecret: ADMIN_SECRET });
  assert.equal((await mint(app, `Bearer ${ADMIN_SECRET}`, {})).status, 400);
});
