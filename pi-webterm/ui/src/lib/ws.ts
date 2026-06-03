export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface WsOptions {
  url: string;
  token: string;
  sessionId?: string; // tmux session name for frame encoding (from session token)
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (err: Event) => void;
  onFatalError?: (code: number, reason: string) => void;
  onOutput?: (data: string) => void;
  onSnapshot?: (data: string) => void;
  onStatus?: (status: { connected: boolean; session: string }) => void;
}

const FRAME_TYPE_BINARY = 0x00;
const FRAME_TYPE_JSON = 0x01;
const FATAL_CLOSE_CODES = new Set([4001, 4002]);

export class WsClient {
  private ws: WebSocket | null = null;
  private options: WsOptions;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;

  private _status: ConnectionStatus = "disconnected";
  get status(): ConnectionStatus {
    return this._status;
  }

  private maxReconnectAttempts = 10;

  constructor(options: WsOptions) {
    this.options = options;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.intentionalClose = false;
    this._status = "connecting";

    // Connect without token in URL (first-message auth)
    this.ws = new WebSocket(this.options.url);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      this._status = "connected";
      this.reconnectAttempts = 0;

      // Send auth as first message
      this.sendAuthMessage();

      this.options.onOpen?.();
    };

    this.ws.onclose = (event: CloseEvent) => {
      this._status = "disconnected";
      this.options.onClose?.();

      if (this.intentionalClose) {
        return;
      }

      // Fatal close codes: don't retry (auth failure, session error)
      if (FATAL_CLOSE_CODES.has(event.code)) {
        const reason = event.reason || "Unknown";
        console.warn(
          `WebSocket closed with fatal code ${event.code}: ${reason}`,
        );
        this.options.onFatalError?.(event.code, reason);
        return;
      }

      // Max retries reached
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        console.warn(
          `WebSocket max retries (${this.maxReconnectAttempts}) reached, giving up`,
        );
        this.options.onFatalError?.(0, "Max reconnection attempts reached");
        return;
      }

      this.scheduleReconnect();
    };

    this.ws.onerror = (_err: Event) => {
      this._status = "error";
    };

    this.ws.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data);
    };
  }

  private sendAuthMessage(): void {
    const authMsg = JSON.stringify({
      type: "auth",
      token: this.options.token,
    });
    this.sendJsonControl(authMsg);
  }

  private sendJsonControl(jsonStr: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(this.buildFrame(FRAME_TYPE_JSON, jsonStr));
  }

  private handleMessage(data: ArrayBuffer | string): void {
    if (data instanceof ArrayBuffer) {
      const buf = new Uint8Array(data);
      if (buf.length === 0) return;

      const type = buf[0];

      if (type === FRAME_TYPE_BINARY) {
        const nullPos = buf.indexOf(0x00, 1);
        if (nullPos !== -1) {
          const outputData = buf.slice(nullPos + 1);
          const decoder = new TextDecoder("utf-8");
          this.options.onOutput?.(decoder.decode(outputData));
        }
      } else if (type === FRAME_TYPE_JSON) {
        const nullPos = buf.indexOf(0x00, 1);
        if (nullPos !== -1) {
          const jsonStr = new TextDecoder("utf-8").decode(
            buf.slice(nullPos + 1),
          );
          try {
            const msg = JSON.parse(jsonStr);
            this.handleJsonMessage(msg);
          } catch {
            // ignore parse errors
          }
        }
      }
    } else if (typeof data === "string") {
      this.options.onOutput?.(data);
    }
  }

  private handleJsonMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case "pong":
        break;
      case "snapshot":
        if (typeof msg.data === "string") {
          this.options.onSnapshot?.(msg.data);
        }
        break;
      case "status":
        if (
          typeof msg.connected === "boolean" &&
          typeof msg.session === "string"
        ) {
          this.options.onStatus?.({
            connected: msg.connected,
            session: msg.session,
          });
        }
        break;
      case "error":
        console.error("Server error:", msg.message);
        break;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(
      1000 * 2 ** this.reconnectAttempts,
      this.maxReconnectDelay,
    );
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private buildFrame(type: number, payload: string | Uint8Array): ArrayBuffer {
    const encoder = new TextEncoder();
    const sessionId = this.options.sessionId || "pw";
    const sessionIdBytes = encoder.encode(sessionId);
    const payloadBytes =
      typeof payload === "string" ? encoder.encode(payload) : payload;

    const frame = new Uint8Array(
      1 + sessionIdBytes.length + 1 + payloadBytes.length,
    );
    frame[0] = type;
    frame.set(sessionIdBytes, 1);
    frame[1 + sessionIdBytes.length] = 0x00;
    frame.set(payloadBytes, 1 + sessionIdBytes.length + 1);
    return frame.buffer.slice(
      frame.byteOffset,
      frame.byteOffset + frame.byteLength,
    );
  }

  private sendFrame(type: number, payload: string | Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(this.buildFrame(type, payload));
  }

  sendInput(data: string): void {
    this.sendFrame(FRAME_TYPE_BINARY, data);
  }

  sendResize(cols: number, rows: number): void {
    const msg = JSON.stringify({ type: "resize", cols, rows });
    this.sendFrame(FRAME_TYPE_JSON, msg);
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this._status = "disconnected";
  }
}
