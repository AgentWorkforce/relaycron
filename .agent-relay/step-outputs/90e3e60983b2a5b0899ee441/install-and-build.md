
added 46 packages, removed 77 packages, and audited 115 packages in 4s

37 packages are looking for funding
  run `npm fund` for details

2 vulnerabilities (1 moderate, 1 high)

To address issues that do not require attention, run:
  npm audit fix

To address all issues (including breaking changes), run:
  npm audit fix --force

Run `npm audit` for details.
packages/server/src/routes/executions.ts(3,37): error TS2307: Cannot find module '@relaycron/types' or its corresponding type declarations.
packages/server/src/routes/schedules.ts(8,8): error TS2307: Cannot find module '@relaycron/types' or its corresponding type declarations.
packages/server/src/routes/schedules.ts(30,21): error TS7006: Parameter 'i' implicitly has an 'any' type.
packages/server/src/routes/schedules.ts(247,21): error TS7006: Parameter 'i' implicitly has an 'any' type.
packages/server/src/routes/ws.ts(5,15): error TS2305: Module '"../types.js"' has no exported member 'Env'.
packages/server/src/routes/ws.ts(6,32): error TS2307: Cannot find module '@relaycron/types' or its corresponding type declarations.
BUILD_WARNINGS
