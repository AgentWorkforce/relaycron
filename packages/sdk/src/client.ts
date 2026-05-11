import type {
  Schedule,
  Execution,
  ApiResponse,
  PaginatedResponse,
  CreateScheduleRequest,
  RegisterScheduleRequest,
  RegisterScheduleSpec,
  UpdateScheduleRequest,
  WsMessage,
  WsMessageType,
  WsTickMessage,
  WsHelloOkMessage,
  WsScheduleRegisteredMessage,
  WsScheduleCancelledMessage,
  WsErrorMessage,
  WsHeartbeatMessage,
  WsRegisterScheduleMessage,
  WsCancelScheduleMessage,
} from "@relaycron/types";

export interface AgentCronOptions {
  apiKey: string;
  baseUrl?: string;
}

export type CreateScheduleParams = CreateScheduleRequest;
export type UpdateScheduleParams = UpdateScheduleRequest;
export interface RegisterScheduleParams {
  name: string;
  description?: string;
  schedule: RegisterScheduleSpec;
  payload?: unknown;
  metadata?: Record<string, unknown>;
  deliveryUrl?: string;
  webSocket?: {
    channel?: string;
    coalesceMissedTicks?: "none" | "fire-once";
  };
}

export interface ListOptions {
  limit?: number;
  cursor?: string;
  status?: string;
}

export interface WsEventHandlers {
  onTick?: (msg: WsTickMessage) => void;
  onScheduleFired?: (msg: WsTickMessage) => void;
  onConnected?: (msg: WsHelloOkMessage) => void;
  onHeartbeat?: (msg: WsHeartbeatMessage) => void;
  onDisconnected?: (code: number, reason: string) => void;
  onError?: (error: Error) => void;
}

interface PendingWsRequest<T> {
  expectedType: WsMessageType;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
    this.name = "AgentCronError";
  }
}

export class AgentCron {
  private apiKey: string;
  private baseUrl: string;
  private ws: WebSocket | null = null;
  private wsHandlers: WsEventHandlers = {};
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = false;
  private lastEventId: string | undefined;
  private isWsAuthenticated = false;
  private wsReady: Promise<void> | null = null;
  private resolveWsReady: (() => void) | null = null;
  private rejectWsReady: ((error: Error) => void) | null = null;
  private pendingWsRequests = new Map<
    string,
    PendingWsRequest<WsScheduleRegisteredMessage | WsScheduleCancelledMessage>
  >();

  constructor(options: AgentCronOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.agentcron.dev").replace(
      /\/$/,
      ""
    );
  }

  // --- HTTP methods ---

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const json = (await res.json()) as
      | ApiResponse<T>
      | { ok: false; error: { code: string; message: string } };

    if (!json.ok) {
      const err = json as { ok: false; error: { code: string; message: string } };
      throw new HttpError(res.status, err.error.code, err.error.message);
    }

    return (json as ApiResponse<T>).data;
  }

  private async requestPaginated<T>(
    path: string,
    params?: Record<string, string | number | undefined>
  ): Promise<PaginatedResponse<T>> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    const json = (await res.json()) as PaginatedResponse<T>;
    if (!json.ok) {
      const err = json as unknown as {
        ok: false;
        error: { code: string; message: string };
      };
      throw new HttpError(res.status, err.error.code, err.error.message);
    }

    return json;
  }

  // --- Schedules ---

  async createSchedule(params: CreateScheduleParams): Promise<Schedule> {
    return this.request<Schedule>("POST", "/v1/schedules", params);
  }

  async register(params: RegisterScheduleParams): Promise<Schedule> {
    return this.request<Schedule>(
      "POST",
      "/v1/schedules",
      this.toRegisterScheduleRequest(params)
    );
  }

  async getSchedule(id: string): Promise<Schedule> {
    return this.request<Schedule>("GET", `/v1/schedules/${id}`);
  }

  async listSchedules(
    options?: ListOptions
  ): Promise<PaginatedResponse<Schedule>> {
    return this.requestPaginated<Schedule>("/v1/schedules", options as Record<string, string | number | undefined>);
  }

  async updateSchedule(
    id: string,
    params: UpdateScheduleParams
  ): Promise<Schedule> {
    return this.request<Schedule>("PATCH", `/v1/schedules/${id}`, params);
  }

  async pauseSchedule(id: string): Promise<Schedule> {
    return this.updateSchedule(id, { status: "paused" });
  }

  async resumeSchedule(id: string): Promise<Schedule> {
    return this.updateSchedule(id, { status: "active" });
  }

  async deleteSchedule(id: string): Promise<void> {
    await this.request("DELETE", `/v1/schedules/${id}`);
  }

  async cancel(id: string): Promise<void> {
    await this.deleteSchedule(id);
  }

  async cancelById(id: string): Promise<void> {
    await this.request("POST", `/v1/schedules/${id}/cancel`);
  }

  // --- Executions ---

  async listExecutions(
    scheduleId: string,
    options?: ListOptions
  ): Promise<PaginatedResponse<Execution>> {
    return this.requestPaginated<Execution>(
      `/v1/schedules/${scheduleId}/executions`,
      options as Record<string, string | number | undefined>
    );
  }

  async getExecution(
    scheduleId: string,
    executionId: string
  ): Promise<Execution> {
    return this.request<Execution>(
      "GET",
      `/v1/schedules/${scheduleId}/executions/${executionId}`
    );
  }

  // --- WebSocket ---

  connect(handlers: WsEventHandlers): void {
    this.wsHandlers = handlers;
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;
    this.ensureWsReadyPromise();
    this.openWebSocket();
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, "Client disconnect");
      this.ws = null;
    }
    this.isWsAuthenticated = false;
    this.rejectPendingWsRequests(new Error("WebSocket disconnected"));
    this.rejectWsReadyPromise(new Error("WebSocket disconnected"));
  }

  private openWebSocket(): void {
    const wsUrl = this.baseUrl
      .replace("https://", "wss://")
      .replace("http://", "ws://");

    this.ws = new WebSocket(`${wsUrl}/v1/ws`);
    this.isWsAuthenticated = false;
    this.ensureWsReadyPromise();

    this.ws.onopen = () => {
      this.ws!.send(
        JSON.stringify({
          type: "client_hello",
          api_key: this.apiKey,
          last_event_id: this.lastEventId,
        })
      );
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(
          typeof event.data === "string" ? event.data : ""
        ) as WsMessage;

        switch (msg.type) {
          case "hello_ok":
            this.reconnectAttempts = 0;
            this.isWsAuthenticated = true;
            this.resolveWsReadyPromise();
            this.wsHandlers.onConnected?.(msg);
            break;
          case "schedule_registered":
            this.resolvePendingWsRequest(msg.request_id, "schedule_registered", msg);
            break;
          case "schedule_cancelled":
            this.resolvePendingWsRequest(msg.request_id, "schedule_cancelled", msg);
            break;
          case "tick":
            this.lastEventId = msg.event_id;
            this.wsHandlers.onTick?.(msg);
            this.wsHandlers.onScheduleFired?.(msg);
            break;
          case "heartbeat":
            this.wsHandlers.onHeartbeat?.(msg);
            break;
          case "error":
            if (!this.rejectPendingWsRequest(msg)) {
              this.wsHandlers.onError?.(
                new Error(`${msg.code}: ${msg.message}`)
              );
            }
            break;
        }
      } catch (err) {
        this.wsHandlers.onError?.(
          err instanceof Error ? err : new Error("Parse error")
        );
      }
    };

    this.ws.onclose = (event) => {
      const reason = event.reason || "WebSocket closed";
      this.isWsAuthenticated = false;
      this.rejectPendingWsRequests(new Error(reason));
      this.rejectWsReadyPromise(new Error(reason));
      this.wsHandlers.onDisconnected?.(event.code, event.reason);
      this.ws = null;
      this.maybeReconnect();
    };

    this.ws.onerror = () => {
      const error = new Error("WebSocket connection error");
      this.rejectWsReadyPromise(error);
      this.wsHandlers.onError?.(error);
    };
  }

  async waitUntilConnected(): Promise<void> {
    if (this.isWsAuthenticated) {
      return;
    }

    if (!this.wsReady) {
      throw new Error("WebSocket connection has not been started. Call connect() first.");
    }

    await this.wsReady;
  }

  async registerViaWebSocket(
    params: RegisterScheduleParams
  ): Promise<Schedule> {
    const response = await this.sendWsRequest<
      WsScheduleRegisteredMessage,
      WsRegisterScheduleMessage
    >(
      "schedule_registered",
      {
        type: "register_schedule",
        schedule: this.toRegisterScheduleRequest(params),
      }
    );

    return response.schedule;
  }

  async cancelViaWebSocket(id: string): Promise<void> {
    await this.sendWsRequest<
      WsScheduleCancelledMessage,
      WsCancelScheduleMessage
    >(
      "schedule_cancelled",
      {
        type: "cancel_schedule",
        schedule_id: id,
      }
    );
  }

  private maybeReconnect(): void {
    if (!this.shouldReconnect) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.wsHandlers.onError?.(
        new Error("Max reconnection attempts reached")
      );
      return;
    }

    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts) + Math.random() * 1000,
      30000
    );
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.openWebSocket();
    }, delay);
  }

  private async sendWsRequest<
    TResponse extends WsScheduleRegisteredMessage | WsScheduleCancelledMessage,
    TRequest extends WsRegisterScheduleMessage | WsCancelScheduleMessage,
  >(expectedType: TResponse["type"], message: Omit<TRequest, "request_id">): Promise<TResponse> {
    await this.waitUntilConnected();

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected");
    }

    const requestId = crypto.randomUUID();
    const payload = { ...message, request_id: requestId } as TRequest;

    const responsePromise = new Promise<TResponse>((resolve, reject) => {
      this.pendingWsRequests.set(requestId, {
        expectedType,
        resolve: (value) => resolve(value as TResponse),
        reject,
      });
    });

    this.ws.send(JSON.stringify(payload));
    return responsePromise;
  }

  private resolvePendingWsRequest(
    requestId: string | undefined,
    expectedType: "schedule_registered" | "schedule_cancelled",
    message: WsScheduleRegisteredMessage | WsScheduleCancelledMessage
  ): void {
    if (!requestId) {
      return;
    }

    const pending = this.pendingWsRequests.get(requestId);
    if (!pending || pending.expectedType !== expectedType) {
      return;
    }

    this.pendingWsRequests.delete(requestId);
    pending.resolve(message);
  }

  private rejectPendingWsRequest(message: WsErrorMessage): boolean {
    if (!message.request_id) {
      return false;
    }

    const pending = this.pendingWsRequests.get(message.request_id);
    if (!pending) {
      return false;
    }

    this.pendingWsRequests.delete(message.request_id);
    pending.reject(new Error(`${message.code}: ${message.message}`));
    return true;
  }

  private rejectPendingWsRequests(error: Error): void {
    for (const [requestId, pending] of this.pendingWsRequests.entries()) {
      this.pendingWsRequests.delete(requestId);
      pending.reject(error);
    }
  }

  private ensureWsReadyPromise(): void {
    if (this.wsReady) {
      return;
    }

    this.wsReady = new Promise<void>((resolve, reject) => {
      this.resolveWsReady = resolve;
      this.rejectWsReady = reject;
    });
  }

  private resolveWsReadyPromise(): void {
    this.resolveWsReady?.();
    this.resolveWsReady = null;
    this.rejectWsReady = null;
    this.wsReady = Promise.resolve();
  }

  private rejectWsReadyPromise(error: Error): void {
    if (this.wsReady && this.rejectWsReady) {
      this.rejectWsReady(error);
    }

    this.wsReady = null;
    this.resolveWsReady = null;
    this.rejectWsReady = null;
  }

  private toRegisterScheduleRequest(
    params: RegisterScheduleParams
  ): RegisterScheduleRequest {
    if (!params.deliveryUrl && !params.webSocket) {
      throw new Error("register() requires either deliveryUrl or webSocket");
    }

    if (params.deliveryUrl && params.webSocket) {
      throw new Error(
        "register() accepts either deliveryUrl or webSocket, not both"
      );
    }

    return {
      name: params.name,
      description: params.description,
      schedule: params.schedule,
      payload: params.payload,
      metadata: params.metadata,
      delivery: params.deliveryUrl
        ? {
            type: "webhook",
            url: params.deliveryUrl,
            timeout_ms: 10000,
          }
        : {
            type: "websocket",
            channel: params.webSocket?.channel,
            coalesce_missed_ticks:
              params.webSocket?.coalesceMissedTicks ?? "none",
          },
    };
  }
}
