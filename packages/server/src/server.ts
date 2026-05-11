import { createAdaptorServer } from "@hono/node-server";
import { createDatabase } from "./db/sqlite.js";
import { LocalScheduler } from "./engine/scheduler.js";
import { createApp } from "./app.js";
import { RelaycronWsGateway } from "./ws-gateway.js";

const db = createDatabase();
const schedulerWithTicks = new LocalScheduler(db);
const wsGateway = new RelaycronWsGateway(db, schedulerWithTicks);
schedulerWithTicks.setTickDispatcher(wsGateway);

await schedulerWithTicks.restoreAlarms();

const port = Number(process.env.PORT) || 4007;
const app = createApp(db, schedulerWithTicks);
const server = createAdaptorServer({ fetch: app.fetch, port });
wsGateway.attach(server);

server.listen(port);

console.log(`RelayCron server running on http://localhost:${port}`);

process.on("SIGINT", () => {
  schedulerWithTicks.cancelAll();
  process.exit(0);
});

process.on("SIGTERM", () => {
  schedulerWithTicks.cancelAll();
  process.exit(0);
});
