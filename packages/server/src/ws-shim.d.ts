declare module "ws" {
  export class WebSocket {
    static readonly OPEN: number;
    readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    on(event: "message", listener: (data: unknown) => void): this;
    on(event: "close", listener: () => void): this;
    on(event: "error", listener: () => void): this;
  }

  export class WebSocketServer {
    constructor(options: { noServer?: boolean });
    on(event: "connection", listener: (ws: WebSocket) => void): this;
    handleUpgrade(
      request: unknown,
      socket: unknown,
      head: Buffer,
      callback: (ws: WebSocket) => void
    ): void;
    emit(event: "connection", ws: WebSocket, request: unknown): void;
  }
}
