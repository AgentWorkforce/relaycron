import { workflow } from "@agent-relay/sdk/workflows";

/**
 * Workflow: Wire RelayCron into ../cloud
 *
 * After 001-local-server.ts strips CF deps from packages/server and exports
 * createApp(db, scheduler), this workflow creates the Cloudflare wrapper in
 * ../cloud that provides D1 + Durable Object backends.
 *
 * Creates:
 *   cloud/packages/relaycron/      — CF Worker that imports @relaycron/server
 *   cloud/infra/relaycron.ts       — SST config (D1, DO, DNS, cron)
 *   cloud/sst.config.ts            — Add relaycron import
 *
 * Pattern: follows cloud/infra/relayauth.ts and cloud/packages/relayauth/
 *
 * Repos touched: cloud/ only (runs in a worktree)
 */

async function main() {
const result = await workflow("002-cloud-infra")
  .description("Wire RelayCron into cloud — CF Worker + D1 + DO + SST")
  .pattern("dag")
  .channel("wf-cloud-infra")
  .maxConcurrency(3)
  .timeout(1_800_000)

  .agent("lead", {
    cli: "claude",
    role: "Architect — reviews cloud infra patterns, designs the wrapper",
    retries: 2,
  })
  .agent("worker-1", {
    cli: "claude",
    preset: "worker",
    role: "Creates the CF Worker wrapper package",
    retries: 2,
  })
  .agent("worker-2", {
    cli: "claude",
    preset: "worker",
    role: "Creates SST infra config",
    retries: 2,
  })

  // ── Read cloud patterns ──────────────────────────────────────────
  .step("read-relayauth-infra", {
    type: "deterministic",
    command: "cat ../cloud/infra/relayauth.ts",
    captureOutput: true,
    failOnError: true,
  })

  .step("read-relayfile-infra", {
    type: "deterministic",
    command: "head -120 ../cloud/infra/relayfile.ts",
    captureOutput: true,
    failOnError: true,
  })

  .step("read-sst-config", {
    type: "deterministic",
    command: "cat ../cloud/sst.config.ts",
    captureOutput: true,
    failOnError: true,
  })

  .step("read-cloud-edge", {
    type: "deterministic",
    command: "cat ../cloud/infra/edge.ts",
    captureOutput: true,
    failOnError: true,
  })

  .step("read-cloud-secrets", {
    type: "deterministic",
    command: "cat ../cloud/infra/secrets.ts",
    captureOutput: true,
    failOnError: true,
  })

  .step("read-relayauth-worker", {
    type: "deterministic",
    command: [
      "echo '=== package.json ==='",
      "cat ../cloud/packages/relayauth/package.json 2>/dev/null || echo 'NOT FOUND'",
      "echo '=== src/ ==='",
      "find ../cloud/packages/relayauth/src -name '*.ts' 2>/dev/null | head -10 || echo 'NOT FOUND'",
      "echo '=== worker entry ==='",
      "cat ../cloud/packages/relayauth/src/worker.ts 2>/dev/null || cat ../cloud/packages/relayauth/src/index.ts 2>/dev/null || echo 'NOT FOUND'",
    ].join(" && "),
    captureOutput: true,
    failOnError: true,
  })

  // Read what relaycron/server now exports (after 001 workflow ran)
  .step("read-relaycron-exports", {
    type: "deterministic",
    command: [
      "echo '=== app.ts ==='",
      "cat packages/server/src/app.ts 2>/dev/null || echo 'NOT YET BUILT — use plan from 001'",
      "echo '=== types.ts ==='",
      "cat packages/server/src/types.ts",
      "echo '=== db/schema.ts ==='",
      "cat packages/server/src/db/schema.ts",
      "echo '=== server package.json ==='",
      "cat packages/server/package.json",
    ].join(" && "),
    captureOutput: true,
    failOnError: true,
  })

  // ── Plan ──────────────────────────────────────────────────────────
  .step("plan", {
    agent: "lead",
    dependsOn: [
      "read-relayauth-infra",
      "read-relayfile-infra",
      "read-sst-config",
      "read-cloud-edge",
      "read-cloud-secrets",
      "read-relayauth-worker",
      "read-relaycron-exports",
    ],
    task: `Design the cloud integration for RelayCron.

After the 001 workflow, @relaycron/server exports:
- createApp(db: Database, scheduler: Scheduler) — returns Hono app
- Scheduler interface: { setAlarm(id, runAt), cancelAlarm(id) }
- Database type from drizzle-orm/better-sqlite3
- DB schema from drizzle-orm/sqlite-core

What @relaycron/server exports:
{{steps.read-relaycron-exports.output}}

CLOUD PATTERNS TO FOLLOW:

relayauth infra:
{{steps.read-relayauth-infra.output}}

relayfile infra:
{{steps.read-relayfile-infra.output}}

sst.config.ts:
{{steps.read-sst-config.output}}

Edge helpers:
{{steps.read-cloud-edge.output}}

Secrets:
{{steps.read-cloud-secrets.output}}

Existing relayauth worker in cloud:
{{steps.read-relayauth-worker.output}}

DESIGN:

1. cloud/packages/relaycron/package.json
   - Dependencies: @relaycron/server (linked via monorepo or npm), drizzle-orm, hono

2. cloud/packages/relaycron/src/worker.ts — CF Worker entry point
   - Import createApp from @relaycron/server (or from the local package)
   - Import the DB schema from @relaycron/server
   - Create a D1-backed drizzle database (drizzle-orm/d1)
   - Create a DurableObjectScheduler that implements the Scheduler interface
     by calling SCHEDULER_DO.idFromName(id).get().fetch("/set-alarm|cancel-alarm")
   - Pass both to createApp(db, scheduler)
   - Export default { fetch: app.fetch, scheduled: cronSweep }
   - Export SchedulerDO class (same as old relaycron durable-objects/scheduler-do.ts)

3. cloud/infra/relaycron.ts — SST config following relayauth pattern:
   - D1 database: relaycron-db
   - Durable Object: SchedulerDO
   - DNS: agentcron.dev (or relaycron subdomain)
   - Cron trigger: * * * * * (fallback sweep)
   - Worker build with nodePaths

4. cloud/sst.config.ts — add relaycron import

Output exact file contents and PLAN_COMPLETE.`,
    verification: { type: "output_contains", value: "PLAN_COMPLETE" },
  })

  // ── Build worker package (worker-1) ───────────────────────────────
  .step("impl-worker-package", {
    agent: "worker-1",
    dependsOn: ["plan"],
    task: `Create the RelayCron CF Worker package in ../cloud/packages/relaycron/.

Plan:
{{steps.plan.output}}

Existing relayauth worker for reference:
{{steps.read-relayauth-worker.output}}

RelayCron server exports:
{{steps.read-relaycron-exports.output}}

Create:

FILE 1: ../cloud/packages/relaycron/package.json
- Follow relayauth worker package pattern
- Deps: hono, drizzle-orm, @relaycron/types (or reference the server)

FILE 2: ../cloud/packages/relaycron/src/worker.ts
- Import { createApp } from the relaycron server (path depends on cloud monorepo setup — check how relayauth does it)
- Import { drizzle } from "drizzle-orm/d1"
- Import DB schema
- Create D1-backed drizzle instance from env.DB
- Create DurableObjectScheduler class implementing Scheduler interface:
  - constructor(env: Env)
  - setAlarm(id, runAt): env.SCHEDULER_DO.idFromName(id).get().fetch("/set-alarm", POST body)
  - cancelAlarm(id): env.SCHEDULER_DO.idFromName(id).get().fetch("/cancel-alarm", POST)
- Export SchedulerDO class (copy the alarm logic from the old durable-objects/scheduler-do.ts — reads schedule, executes webhook, records, advances, re-arms)
- Export default { fetch: (req, env, ctx) => { db = drizzle(env.DB); scheduler = new DOScheduler(env); app = createApp(db, scheduler); return app.fetch(req, env, ctx) } }

FILE 3: ../cloud/packages/relaycron/tsconfig.json

Create directories as needed. Write to disk.
IMPORTANT: Write the files to disk. Do NOT output to stdout.`,
    verification: { type: "file_exists", value: "../cloud/packages/relaycron/src/worker.ts" },
  })

  // ── SST infra (worker-2) ─────────────────────────────────────────
  .step("impl-infra", {
    agent: "worker-2",
    dependsOn: ["plan"],
    task: `Create the SST infra config for RelayCron in ../cloud/.

Plan:
{{steps.plan.output}}

Follow the relayauth pattern:
{{steps.read-relayauth-infra.output}}

Edge helpers:
{{steps.read-cloud-edge.output}}

Current sst.config.ts:
{{steps.read-sst-config.output}}

Create:

FILE 1: ../cloud/infra/relaycron.ts
- Follow relayauth.ts pattern exactly
- D1 database binding
- SchedulerDO Durable Object
- DNS hostname (check what domain pattern relayauth uses)
- Cron trigger: * * * * *
- Worker build config with nodePaths pointing to packages/relaycron
- Export relaycron object with URL

FILE 2: Update ../cloud/sst.config.ts
- Add: const { relaycron } = await import("./infra/relaycron")
- Add relaycron to the return object
- Follow the exact pattern of the relayauth/relayfile imports

Only create/edit these 2 files. Write to disk.
IMPORTANT: Write the files to disk. Do NOT output to stdout.`,
    verification: { type: "file_exists", value: "../cloud/infra/relaycron.ts" },
  })

  // ── Verify ────────────────────────────────────────────────────────
  .step("verify", {
    type: "deterministic",
    dependsOn: ["impl-worker-package", "impl-infra"],
    command: [
      "test -f ../cloud/packages/relaycron/src/worker.ts",
      "test -f ../cloud/packages/relaycron/package.json",
      "test -f ../cloud/infra/relaycron.ts",
      "grep -q 'relaycron' ../cloud/sst.config.ts",
      "echo 'CLOUD_VERIFIED'",
    ].join(" && "),
    captureOutput: true,
    failOnError: true,
  })

  .onError("retry", { maxRetries: 2, retryDelayMs: 10_000 })
  .run({ cwd: process.cwd() });

console.log("Result:", result.status);
}
main().catch(console.error);
