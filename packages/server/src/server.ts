import { serve } from "@hono/node-server";
import { createDatabase } from "./db/sqlite.js";
import { LocalScheduler } from "./engine/scheduler.js";
import { createApp } from "./app.js";

const db = createDatabase();
const scheduler = new LocalScheduler(db);

await scheduler.restoreAlarms();

const port = Number(process.env.PORT) || 4007;

serve({ fetch: createApp(db, scheduler).fetch, port });

console.log(`RelayCron server running on http://localhost:${port}`);

process.on("SIGINT", () => {
  scheduler.cancelAll();
  process.exit(0);
});

process.on("SIGTERM", () => {
  scheduler.cancelAll();
  process.exit(0);
});
