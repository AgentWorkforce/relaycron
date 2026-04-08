import { workflow } from "@agent-relay/sdk/workflows";

/**
 * Workflow: Create @relayfile/adapter-agentcron
 *
 * Builds a relayfile adapter that integrates AgentCron scheduled events
 * into relayfile workspaces. When AgentCron fires a schedule (via webhook),
 * the adapter ingests it as a file in the relayfile filesystem.
 *
 * Reference adapter: @relayfile/adapter-github in ../relayfile-adapters/packages/github
 * AgentCron SDK: @agentcron/sdk in ./packages/sdk
 */

const result = await workflow("001-agentcron-adapter")
  .description(
    "Create @relayfile/adapter-agentcron package in relayfile-adapters"
  )
  .pattern("dag")
  .channel("wf-agentcron-adapter")
  .maxConcurrency(4)
  .timeout(3_600_000)

  .agent("lead", {
    cli: "claude",
    role: "Architect — designs the adapter structure and reviews implementation",
    retries: 2,
  })
  .agent("scaffold-worker", {
    cli: "claude",
    preset: "worker",
    role: "Scaffolds the adapter package",
    retries: 2,
  })
  .agent("impl-worker-1", {
    cli: "claude",
    preset: "worker",
    role: "Implements adapter core logic",
    retries: 2,
  })
  .agent("impl-worker-2", {
    cli: "claude",
    preset: "worker",
    role: "Implements types and config",
    retries: 2,
  })
  .agent("test-worker", {
    cli: "claude",
    preset: "worker",
    role: "Writes tests for the adapter",
    retries: 2,
  })

  // Step 1: Read reference materials
  .step("read-github-adapter", {
    type: "deterministic",
    command: [
      "cat ../relayfile-adapters/packages/github/package.json",
      "echo '---SEPARATOR---'",
      "cat ../relayfile-adapters/packages/github/src/index.ts",
      "echo '---SEPARATOR---'",
      "cat ../relayfile-adapters/packages/github/src/types.ts",
      "echo '---SEPARATOR---'",
      "cat ../relayfile-adapters/packages/github/src/config.ts",
      "echo '---SEPARATOR---'",
      "cat ../relayfile-adapters/packages/github/tsconfig.json",
    ].join(" && "),
    captureOutput: true,
  })

  .step("read-agentcron-sdk", {
    type: "deterministic",
    command: [
      "cat packages/sdk/src/client.ts",
      "echo '---SEPARATOR---'",
      "cat packages/types/src/schemas.ts",
    ].join(" && "),
    captureOutput: true,
  })

  .step("read-adapter-core", {
    type: "deterministic",
    command: "cat ../relayfile-adapters/packages/core/src/index.ts",
    captureOutput: true,
  })

  // Step 2: Plan the adapter
  .step("plan", {
    agent: "lead",
    task: `You are designing a @relayfile/adapter-agentcron package. This adapter receives AgentCron webhook payloads (schedule_fired events) and ingests them as files in a relayfile workspace.

Here is the reference GitHub adapter structure:
{{steps.read-github-adapter.output}}

Here is the AgentCron SDK and types:
{{steps.read-agentcron-sdk.output}}

Here is the adapter-core interface:
{{steps.read-adapter-core.output}}

Design the adapter with:
1. Package structure mirroring the GitHub adapter (package.json, tsconfig.json, src/)
2. AgentCronAdapter class extending IntegrationAdapter
3. Webhook ingestion: receives AgentCron webhook POST (with X-AgentCron-Delivery header), maps to relayfile paths like /agentcron/schedules/{id}/executions/{eid}/payload.json
4. Types: AgentCronAdapterConfig, AgentCronWebhookPayload (schedule_id, schedule_name, execution_id, payload, fired_at)
5. Config with defaults
6. computePath and computeSemantics implementations

Output a detailed plan with exact file paths and interfaces. The package lives at ../relayfile-adapters/packages/agentcron/`,
    dependsOn: ["read-github-adapter", "read-agentcron-sdk", "read-adapter-core"],
    verification: { type: "output_contains", value: "PLAN_COMPLETE" },
  })

  // Step 3: Scaffold package (parallel with types)
  .step("scaffold-package", {
    agent: "scaffold-worker",
    task: `Create the @relayfile/adapter-agentcron package scaffold at ../relayfile-adapters/packages/agentcron/ based on this plan:

{{steps.plan.output}}

Create these files:
1. package.json — name: @relayfile/adapter-agentcron, version 0.1.0, mirroring the github adapter's structure. Dependencies: @relayfile/adapter-core. Peer dep: @relayfile/sdk.
2. tsconfig.json — same pattern as github adapter, targeting ES2022, Node16 module
3. src/index.ts — stub export of AgentCronAdapter class

Only create these 3 files. Write them to disk at ../relayfile-adapters/packages/agentcron/.
IMPORTANT: Write the files to disk. Do NOT output to stdout.`,
    dependsOn: ["plan"],
    verification: { type: "file_exists", value: "../relayfile-adapters/packages/agentcron/package.json" },
  })

  .step("verify-scaffold", {
    type: "deterministic",
    dependsOn: ["scaffold-package"],
    command:
      "test -f ../relayfile-adapters/packages/agentcron/package.json && test -f ../relayfile-adapters/packages/agentcron/tsconfig.json && test -f ../relayfile-adapters/packages/agentcron/src/index.ts && echo 'SCAFFOLD_OK'",
    failOnError: true,
  })

  // Step 3b: Types and config (parallel with scaffold)
  .step("impl-types", {
    agent: "impl-worker-2",
    task: `Create the types and config files for @relayfile/adapter-agentcron based on this plan:

{{steps.plan.output}}

Create these files at ../relayfile-adapters/packages/agentcron/:

1. src/types.ts — Define:
   - AgentCronAdapterConfig interface (baseUrl, supportedEvents)
   - AgentCronWebhookPayload interface (matching what AgentCron sends: schedule_id, schedule_name, execution_id, payload, fired_at, transport_type)
   - IngestResult, WritebackResult types
   - Re-export IntegrationAdapter abstract class

2. src/config.ts — Define:
   - DEFAULT_CONFIG with sensible defaults
   - validateConfig function

Only create these 2 files. Write them to disk.
IMPORTANT: Write the files to disk. Do NOT output to stdout.`,
    dependsOn: ["plan"],
    verification: { type: "file_exists", value: "../relayfile-adapters/packages/agentcron/src/types.ts" },
  })

  .step("verify-types", {
    type: "deterministic",
    dependsOn: ["impl-types"],
    command:
      "test -f ../relayfile-adapters/packages/agentcron/src/types.ts && test -f ../relayfile-adapters/packages/agentcron/src/config.ts && echo 'TYPES_OK'",
    failOnError: true,
  })

  // Step 4: Core adapter implementation
  .step("read-types-file", {
    type: "deterministic",
    dependsOn: ["verify-types", "verify-scaffold"],
    command: "cat ../relayfile-adapters/packages/agentcron/src/types.ts",
    captureOutput: true,
  })

  .step("impl-adapter", {
    agent: "impl-worker-1",
    task: `Implement the main AgentCronAdapter class at ../relayfile-adapters/packages/agentcron/src/index.ts.

Here is the plan:
{{steps.plan.output}}

Here are the types already created:
{{steps.read-types-file.output}}

The adapter should:
1. Extend IntegrationAdapter and implement WebhookAdapter
2. name: 'agentcron', version: '0.1.0'
3. ingestWebhook(workspaceId, event) — parses the AgentCron webhook payload, writes it to a relayfile path
4. routeWebhook(payload, eventType, headers) — routes based on X-AgentCron-Delivery header
5. computePath(objectType, objectId) — returns paths like /agentcron/schedules/{schedule_id}/executions/{execution_id}/payload.json
6. computeSemantics(objectType, objectId, payload) — returns properties (schedule_name, status, fired_at) and relations

Only edit ../relayfile-adapters/packages/agentcron/src/index.ts. Only edit this one file.
IMPORTANT: Write the file to disk. Do NOT output to stdout.`,
    dependsOn: ["read-types-file"],
    verification: { type: "exit_code" },
  })

  .step("verify-adapter", {
    type: "deterministic",
    dependsOn: ["impl-adapter"],
    command:
      "if git -C ../relayfile-adapters diff --quiet ../relayfile-adapters/packages/agentcron/src/index.ts 2>/dev/null; then cat ../relayfile-adapters/packages/agentcron/src/index.ts | wc -l | xargs test 10 -lt && echo 'ADAPTER_OK' || (echo 'ADAPTER_TOO_SHORT'; exit 1); else echo 'ADAPTER_OK'; fi",
    failOnError: true,
  })

  // Step 5: Tests
  .step("read-adapter-file", {
    type: "deterministic",
    dependsOn: ["verify-adapter"],
    command: "cat ../relayfile-adapters/packages/agentcron/src/index.ts",
    captureOutput: true,
  })

  .step("impl-tests", {
    agent: "test-worker",
    task: `Write tests for the AgentCronAdapter at ../relayfile-adapters/packages/agentcron/src/__tests__/adapter.test.ts.

Here is the adapter implementation:
{{steps.read-adapter-file.output}}

Here are the types:
{{steps.read-types-file.output}}

Write tests using Node.js native test module (import { describe, it } from 'node:test' and import assert from 'node:assert/strict'). Test:
1. Adapter instantiation and properties (name, version)
2. computePath returns correct paths for schedule executions
3. computeSemantics returns correct properties and relations
4. ingestWebhook parses a sample AgentCron payload correctly
5. Config validation with defaults

Create the directory and file at ../relayfile-adapters/packages/agentcron/src/__tests__/adapter.test.ts.
Only create this one file.
IMPORTANT: Write the file to disk. Do NOT output to stdout.`,
    dependsOn: ["read-adapter-file"],
    verification: {
      type: "file_exists",
      value: "../relayfile-adapters/packages/agentcron/src/__tests__/adapter.test.ts",
    },
  })

  // Step 6: Final build check
  .step("build-check", {
    type: "deterministic",
    dependsOn: ["impl-tests"],
    command:
      "cd ../relayfile-adapters/packages/agentcron && npx tsc --noEmit 2>&1 || echo 'BUILD_WARNINGS'",
    captureOutput: true,
  })

  .onError("retry", { maxRetries: 2, retryDelayMs: 10_000 })
  .run({ cwd: process.cwd() });

console.log("Result:", result.status);
