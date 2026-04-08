import type {
  Schedule,
  Execution,
  ApiResponse,
  PaginatedResponse,
  CreateScheduleRequest,
  UpdateScheduleRequest,
  WsMessage,
  WsScheduleFiredMessage,
} from "@agentcron/types";

export interface AgentCronOptions {
  apiKey: string;
  baseUrl?: string;
}

export type CreateScheduleParams = CreateScheduleRequest;
export type UpdateScheduleParams = UpdateScheduleRequest;

export interface ListOptions {
  limit?: number;
  cursor?: string;
  status?: string;
}

export interface WsEventHandlers {
  onScheduleFired?: (msg: WsScheduleFiredMessage) => void;
  onConnected?: () => void;
  onDisconnected?: (code: number, reason: string) => void;
  onError?: (error: Error) => void;
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
  }

  private openWebSocket(): void {
    const wsUrl = this.baseUrl
      .replace("https://", "wss://")
      .replace("http://", "ws://");

    this.ws = new WebSocket(`${wsUrl}/v1/ws`);

    this.ws.onopen = () => {
      this.ws!.send(JSON.stringify({ type: "auth", api_key: this.apiKey }));
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(
          typeof event.data === "string" ? event.data : ""
        ) as WsMessage;

        switch (msg.type) {
          case "auth_ok":
            this.reconnectAttempts = 0;
            this.wsHandlers.onConnected?.();
            break;
          case "schedule_fired":
            this.wsHandlers.onScheduleFired?.(msg as WsScheduleFiredMessage);
            break;
          case "error":
            this.wsHandlers.onError?.(
              new Error(`${msg.code}: ${msg.message}`)
            );
            break;
        }
      } catch (err) {
        this.wsHandlers.onError?.(
          err instanceof Error ? err : new Error("Parse error")
        );
      }
    };

    this.ws.onclose = (event) => {
      this.wsHandlers.onDisconnected?.(event.code, event.reason);
      this.ws = null;
      this.maybeReconnect();
    };

    this.ws.onerror = () => {
      this.wsHandlers.onError?.(new Error("WebSocket connection error"));
    };
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
}
