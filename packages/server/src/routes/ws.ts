import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { apiKeys } from "../db/schema.js";
import { hashKey } from "../middleware/auth.js";
import type { Env } from "../types.js";
import type { WsMessage } from "@agentcron/types";

// In-memory connected clients (per worker isolate)
// Maps api_key_id -> Set of WebSocket connections
const connectedClients = new Map<string, Set<WebSocket>>();

export function broadcastToKey(apiKeyId: string, message: WsMessage): number {
  const clients = connectedClients.get(apiKeyId);
  if (!clients) return 0;

  let sent = 0;
  for (const ws of clients) {
    try {
      ws.send(JSON.stringify(message));
      sent++;
    } catch {
      clients.delete(ws);
    }
  }
  return sent;
}

const wsRouter = new Hono<{ Bindings: Env }>();

wsRouter.get("/", async (c) => {
  const upgradeHeader = c.req.header("Upgrade");
  if (upgradeHeader !== "websocket") {
    return c.json(
      {
        ok: false,
        error: {
          code: "bad_request",
          message: "Expected WebSocket upgrade",
        },
      },
      426
    );
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);

  server.accept();

  let authenticated = false;
  let apiKeyId: string | null = null;
  const authTimeout = setTimeout(() => {
    if (!authenticated) {
      server.send(
        JSON.stringify({
          type: "error",
          code: "auth_timeout",
          message: "Authentication timeout",
        })
      );
      server.close(4001, "Authentication timeout");
    }
  }, 10000);

  server.addEventListener("message", async (event) => {
    try {
      const msg = JSON.parse(
        typeof event.data === "string" ? event.data : ""
      ) as WsMessage;

      if (!authenticated) {
        if (msg.type === "auth" && "api_key" in msg) {
          const keyHash = await hashKey(msg.api_key);
          const db = c.get("db");
          const [key] = await db
            .select()
            .from(apiKeys)
            .where(eq(apiKeys.key_hash, keyHash))
            .limit(1);

          if (!key) {
            server.send(
              JSON.stringify({
                type: "error",
                code: "unauthorized",
                message: "Invalid API key",
              })
            );
            server.close(4003, "Unauthorized");
            return;
          }

          authenticated = true;
          apiKeyId = key.id;
          clearTimeout(authTimeout);

          // Register connection
          if (!connectedClients.has(apiKeyId)) {
            connectedClients.set(apiKeyId, new Set());
          }
          connectedClients.get(apiKeyId)!.add(server);

          server.send(
            JSON.stringify({ type: "auth_ok", agent_id: key.id })
          );
        }
        return;
      }

      if (msg.type === "ping") {
        server.send(JSON.stringify({ type: "pong" }));
      }
    } catch {
      server.send(
        JSON.stringify({
          type: "error",
          code: "parse_error",
          message: "Invalid message format",
        })
      );
    }
  });

  server.addEventListener("close", () => {
    clearTimeout(authTimeout);
    if (apiKeyId) {
      connectedClients.get(apiKeyId)?.delete(server);
      if (connectedClients.get(apiKeyId)?.size === 0) {
        connectedClients.delete(apiKeyId);
      }
    }
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
});

export default wsRouter;
