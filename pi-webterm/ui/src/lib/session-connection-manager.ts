import { WsClient, type WsOptions } from "./ws.js";

export interface SessionTransport {
  connect(): void;
  disconnect(): void;
  sendInput(data: string): void;
  sendResize(cols: number, rows: number): void;
}

export interface SessionTransportHandlers {
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (err: Event) => void;
  onFatalError?: (code: number, reason: string) => void;
  onOutput?: (data: string) => void;
  onSnapshot?: (data: string) => void;
  onStatus?: (status: { connected: boolean; session: string }) => void;
}

export interface SessionConnectionParams {
  url: string;
  token: string;
  sessionId: string;
}

export type SessionTransportFactory = (options: WsOptions) => SessionTransport;

function createWsTransport(options: WsOptions): SessionTransport {
  return new WsClient(options);
}

export class SessionConnectionManager {
  private activeTransport: SessionTransport | null = null;
  private generation = 0;

  constructor(
    private readonly options: SessionTransportHandlers & {
      createTransport?: SessionTransportFactory;
    },
  ) {}

  switchSession(params: SessionConnectionParams): void {
    this.generation += 1;
    const generation = this.generation;

    this.activeTransport?.disconnect();

    const createTransport = this.options.createTransport ?? createWsTransport;
    const transport = createTransport({
      ...params,
      onOpen: () => {
        if (!this.isCurrent(generation)) return;
        this.options.onOpen?.();
      },
      onClose: () => {
        if (!this.isCurrent(generation)) return;
        this.options.onClose?.();
      },
      onError: (err) => {
        if (!this.isCurrent(generation)) return;
        this.options.onError?.(err);
      },
      onFatalError: (code, reason) => {
        if (!this.isCurrent(generation)) return;
        this.options.onFatalError?.(code, reason);
      },
      onOutput: (data) => {
        if (!this.isCurrent(generation)) return;
        this.options.onOutput?.(data);
      },
      onSnapshot: (data) => {
        if (!this.isCurrent(generation)) return;
        this.options.onSnapshot?.(data);
      },
      onStatus: (status) => {
        if (!this.isCurrent(generation)) return;
        this.options.onStatus?.(status);
      },
    });

    this.activeTransport = transport;
    transport.connect();
  }

  sendInput(data: string): void {
    console.log("[pi-webterm] SessionConnectionManager.sendInput", {
      data,
      codePoints: Array.from(data).map((char) => char.charCodeAt(0)),
      hasActiveTransport: Boolean(this.activeTransport),
    });
    this.activeTransport?.sendInput(data);
  }

  sendResize(cols: number, rows: number): void {
    this.activeTransport?.sendResize(cols, rows);
  }

  disconnect(): void {
    this.generation += 1;
    this.activeTransport?.disconnect();
    this.activeTransport = null;
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation;
  }
}
