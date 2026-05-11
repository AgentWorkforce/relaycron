import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { nanoid } from "nanoid";
import { WebSocket, WebSocketServer } from "ws";
import { eq } from "drizzle-orm";
import type {
  WsMessage,
  WsTickMessage,
  WsClientHelloMessage,
  WsRegisterScheduleMessage,
  WsCancelScheduleMessage,
} from "@relaycron/types";
import { apiKeys } from "./db/schema.js";
import { hashKey } from "./middleware/auth.js";
import {
  cancelScheduleRecord,
  createScheduleRecord,
  formatSchedule,
  parseScheduleRequest,
} from "./lib/schedules.js";
import type { Database, Scheduler, TickDispatcher, TickDispatchRequest } from "./types.js";

interface Session {
  id: string;
  ws: WebSocket;
  apiKeyId: string | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
}

interface BufferedTick {
  sequence: number;
  coalesceMissedTicks: "none" | "fire-once";
  message: WsTickMessage;
}

const MAX_BUFFERED_TICKS = 512;
const HEARTBEAT_INTERVAL_MS = 25000;

export class RelaycronWsGateway implements TickDispatcher {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly sessions = new Map<string, Session>();
  private readonly sessionsByApiKeyId = new Map<string, Set<string>>();
  private readonly bufferedTicks = new Map<string, BufferedTick[]>();
  private sequence = 0;

  constructor(
    private readonly db: Database,
    private readonly scheduler: Scheduler
  ) {
    this.wss.on("connection", (ws) => {
      void this.handleConnection(ws);
    });
  }

  attach(server: {
    on(event: "upgrade", listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): void;
  }): void {
    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== "/v1/ws") {
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit("connection", ws, request);
      });
    });
  }

  deliverTick(request: TickDispatchRequest): void {
    const tick: WsTickMessage = {
      type: "tick",
      event_id: nanoid(),
      schedule_id: request.scheduleId,
      schedule_name: request.scheduleName,
      scheduled_for: request.scheduledFor,
      occurred_at: request.occurredAt,
      execution_id: request.executionId,
      payload: request.payload,
    };

    const buffered = this.bufferedTicks.get(request.apiKeyId) ?? [];
    buffered.push({
      sequence: ++this.sequence,
      coalesceMissedTicks: request.coalesceMissedTicks,
      message: tick,
    });
    if (buffered.length > MAX_BUFFERED_TICKS) {
      buffered.splice(0, buffered.length - MAX_BUFFERED_TICKS);
    }
    this.bufferedTicks.set(request.apiKeyId, buffered);

    const sessionIds = this.sessionsByApiKeyId.get(request.apiKeyId);
    if (!sessionIds) {
      return;
    }

    for (const sessionId of sessionIds) {
      const session = this.sessions.get(sessionId);
      if (session) {
        this.send(session.ws, tick);
      }
    }
  }

  private async handleConnection(ws: WebSocket): Promise<void> {
    const session: Session = {
      id: nanoid(),
      ws,
      apiKeyId: null,
      heartbeatTimer: null,
    };

    this.sessions.set(session.id, session);

    const authTimeout = setTimeout(() => {
      if (!session.apiKeyId) {
        this.sendError(ws, "auth_timeout", "Authentication timeout");
        ws.close(4001, "Authentication timeout");
      }
    }, 10000);

    ws.on("message", (data) => {
      void this.handleMessage(session, String(data));
    });
    ws.on("close", () => {
      clearTimeout(authTimeout);
      this.cleanupSession(session.id);
    });
    ws.on("error", () => {
      clearTimeout(authTimeout);
      this.cleanupSession(session.id);
    });
  }

  private async handleMessage(session: Session, raw: string): Promise<void> {
    let message: WsMessage;

    try {
      message = JSON.parse(raw) as WsMessage;
    } catch {
      this.sendError(session.ws, "parse_error", "Invalid message format");
      return;
    }

    if (!session.apiKeyId) {
      if (message.type !== "client_hello") {
        this.sendError(
          session.ws,
          "unauthorized",
          "Send client_hello before any other websocket command"
        );
        return;
      }

      await this.handleClientHello(session, message);
      return;
    }

    switch (message.type) {
      case "register_schedule":
        await this.handleRegisterSchedule(session, message);
        break;
      case "cancel_schedule":
        await this.handleCancelSchedule(session, message);
        break;
      default:
        this.sendError(
          session.ws,
          "unsupported_message",
          `Unsupported message type: ${message.type}`
        );
    }
  }

  private async handleClientHello(
    session: Session,
    message: WsClientHelloMessage
  ): Promise<void> {
    if (!message.api_key.startsWith("ac_")) {
      this.sendError(session.ws, "unauthorized", "Invalid API key format");
      session.ws.close(4003, "Unauthorized");
      return;
    }

    const keyHash = hashKey(message.api_key);
    const [key] = await this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.key_hash, keyHash))
      .limit(1);

    if (!key) {
      this.sendError(session.ws, "unauthorized", "Invalid API key");
      session.ws.close(4003, "Unauthorized");
      return;
    }

    session.apiKeyId = key.id;
    const sessions = this.sessionsByApiKeyId.get(key.id) ?? new Set<string>();
    sessions.add(session.id);
    this.sessionsByApiKeyId.set(key.id, sessions);

    this.startHeartbeat(session);
    const replayQueue = this.getReplayQueue(key.id, message.last_event_id);

    this.send(session.ws, {
      type: "hello_ok",
      agent_id: key.id,
      replayed: replayQueue.length,
      heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
    });
    for (const entry of replayQueue) {
      this.send(session.ws, entry.message);
    }
  }

  private async handleRegisterSchedule(
    session: Session,
    message: WsRegisterScheduleMessage
  ): Promise<void> {
    const parsed = parseScheduleRequest(message.schedule);
    if (!parsed.ok) {
      this.sendError(
        session.ws,
        parsed.error.code,
        parsed.error.message,
        message.request_id
      );
      return;
    }

    const record = await createScheduleRecord(
      this.db,
      this.scheduler,
      session.apiKeyId!,
      parsed.data
    );

    this.send(session.ws, {
      type: "schedule_registered",
      request_id: message.request_id,
      schedule: formatSchedule(record),
    });
  }

  private async handleCancelSchedule(
    session: Session,
    message: WsCancelScheduleMessage
  ): Promise<void> {
    const existing = await cancelScheduleRecord(
      this.db,
      this.scheduler,
      session.apiKeyId!,
      message.schedule_id
    );

    if (!existing) {
      this.sendError(
        session.ws,
        "not_found",
        "Schedule not found",
        message.request_id
      );
      return;
    }

    this.send(session.ws, {
      type: "schedule_cancelled",
      request_id: message.request_id,
      schedule_id: message.schedule_id,
    });
  }

  private getReplayQueue(
    apiKeyId: string,
    lastEventId?: string
  ): BufferedTick[] {
    if (!lastEventId) {
      return [];
    }

    const buffered = this.bufferedTicks.get(apiKeyId) ?? [];
    if (buffered.length === 0) {
      return [];
    }

    const startIndex = lastEventId
      ? Math.max(
          0,
          buffered.findIndex((entry) => entry.message.event_id === lastEventId) + 1
        )
      : 0;
    const pending = buffered.slice(startIndex);
    return this.coalesceReplayTicks(pending);
  }

  private coalesceReplayTicks(entries: BufferedTick[]): BufferedTick[] {
    const passthrough: BufferedTick[] = [];
    const latestByScheduleId = new Map<string, BufferedTick>();

    for (const entry of entries) {
      if (entry.coalesceMissedTicks === "fire-once") {
        latestByScheduleId.set(entry.message.schedule_id, entry);
      } else {
        passthrough.push(entry);
      }
    }

    return [...passthrough, ...latestByScheduleId.values()].sort(
      (a, b) => a.sequence - b.sequence
    );
  }

  private startHeartbeat(session: Session): void {
    if (session.heartbeatTimer) {
      clearInterval(session.heartbeatTimer);
    }

    session.heartbeatTimer = setInterval(() => {
      if (session.ws.readyState === WebSocket.OPEN) {
        this.send(session.ws, {
          type: "heartbeat",
          sent_at: new Date().toISOString(),
        });
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private cleanupSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    if (session.heartbeatTimer) {
      clearInterval(session.heartbeatTimer);
    }

    if (session.apiKeyId) {
      const sessions = this.sessionsByApiKeyId.get(session.apiKeyId);
      if (sessions) {
        sessions.delete(sessionId);
        if (sessions.size === 0) {
          this.sessionsByApiKeyId.delete(session.apiKeyId);
        }
      }
    }

    this.sessions.delete(sessionId);
  }

  private send(ws: WebSocket, message: WsMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private sendError(
    ws: WebSocket,
    code: string,
    message: string,
    requestId?: string
  ): void {
    this.send(ws, {
      type: "error",
      code,
      message,
      request_id: requestId,
    });
  }
}
