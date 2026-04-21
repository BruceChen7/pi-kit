import http from "node:http";

import type { KanbanApiResponse } from "./api-routes.js";
import {
  handleBootstrapRequest,
  handleTerminalInputRequest,
} from "./api-routes.js";
import type {
  KanbanChildLifecycleEvent,
  KanbanTerminalEvent,
} from "./runtime-state.js";
import type { KanbanActionRequestState } from "./service.js";

function parseJsonBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8").trim();
      if (!raw) {
        resolve({});
        return;
      }

      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          resolve(parsed as Record<string, unknown>);
          return;
        }
        reject(new Error("Request body must be a JSON object"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function writeCorsHeaders(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
}

function writeJson(
  res: http.ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
): void {
  writeCorsHeaders(res);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(`${JSON.stringify(body)}\n`);
}

function isAuthorized(
  req: http.IncomingMessage,
  url: URL,
  token: string,
): boolean {
  const expectedToken = token.trim();
  if (!expectedToken) {
    return true;
  }

  const header = req.headers.authorization;
  if (header === `Bearer ${expectedToken}`) {
    return true;
  }

  return url.searchParams.get("token") === expectedToken;
}

export type KanbanRuntimeServer = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  readonly baseUrl: string;
};

export type KanbanRuntimeServerBackend = {
  executeAction: (body: Record<string, unknown>) => KanbanApiResponse;
  getActionStatus: (requestId: string) => KanbanApiResponse;
  cancelAction: (
    requestId: string,
  ) => Promise<KanbanApiResponse> | KanbanApiResponse;
  getCardContext: (cardQuery: string) => KanbanApiResponse;
  getCardRuntime: (cardQuery: string) => KanbanApiResponse;
  sendTerminalInput: (
    cardQuery: string,
    input: string,
  ) => Promise<KanbanApiResponse> | KanbanApiResponse;
  readBoard: () => KanbanApiResponse;
  patchBoard: (nextBoardText: string) => KanbanApiResponse;
  subscribeActionStream: (
    onEvent: (state: KanbanActionRequestState) => void,
  ) => () => void;
  subscribeLifecycleStream: (
    onEvent: (event: KanbanChildLifecycleEvent) => void,
  ) => () => void;
  subscribeTerminalStream: (
    cardId: string,
    onEvent: (event: KanbanTerminalEvent) => void,
  ) => () => void;
};

export function createKanbanRuntimeServer(input: {
  host: string;
  port: number;
  token: string;
  workspaceId: string;
  backend: KanbanRuntimeServerBackend;
}): KanbanRuntimeServer {
  if (!input.backend) {
    throw new Error("backend is required");
  }

  if (
    typeof input.backend.subscribeActionStream !== "function" ||
    typeof input.backend.subscribeLifecycleStream !== "function" ||
    typeof input.backend.subscribeTerminalStream !== "function"
  ) {
    throw new Error("backend stream subscriptions are required");
  }

  let server: http.Server | null = null;
  let startedPort = input.port;

  const requestHandler: http.RequestListener = async (req, res) => {
    const url = new URL(
      req.url ?? "/",
      `http://${input.host}:${startedPort || input.port || 80}`,
    );

    if (req.method === "OPTIONS") {
      writeCorsHeaders(res);
      res.statusCode = 204;
      res.end();
      return;
    }

    if (!isAuthorized(req, url, input.token)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/kanban/stream") {
      writeCorsHeaders(res);
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      res.write("event: ready\ndata: {}\n\n");

      const unsubscribeState = input.backend.subscribeActionStream((state) => {
        res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
      });
      const unsubscribeLifecycle = input.backend.subscribeLifecycleStream(
        (event) => {
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        },
      );

      const ping = setInterval(() => {
        res.write(": ping\n\n");
      }, 15_000);

      req.on("close", () => {
        clearInterval(ping);
        unsubscribeState();
        unsubscribeLifecycle();
      });
      return;
    }

    try {
      if (req.method === "POST" && url.pathname === "/kanban/bootstrap") {
        const response = handleBootstrapRequest({
          workspaceId: input.workspaceId,
        });
        writeJson(res, response.status, response.body);
        return;
      }

      if (req.method === "POST" && url.pathname === "/kanban/actions/execute") {
        const body = await parseJsonBody(req);
        const response = input.backend.executeAction(body);
        writeJson(res, response.status, response.body);
        return;
      }

      const cancelMatch = url.pathname.match(
        /^\/kanban\/actions\/([^/]+)\/cancel$/,
      );
      if (req.method === "POST" && cancelMatch) {
        const requestId = decodeURIComponent(cancelMatch[1] ?? "");
        const response = await input.backend.cancelAction(requestId);
        writeJson(res, response.status, response.body);
        return;
      }

      const actionMatch = url.pathname.match(/^\/kanban\/actions\/([^/]+)$/);
      if (req.method === "GET" && actionMatch) {
        const requestId = decodeURIComponent(actionMatch[1] ?? "");
        const response = input.backend.getActionStatus(requestId);
        writeJson(res, response.status, response.body);
        return;
      }

      const runtimeMatch = url.pathname.match(
        /^\/kanban\/cards\/([^/]+)\/runtime$/,
      );
      if (req.method === "GET" && runtimeMatch) {
        const cardQuery = decodeURIComponent(runtimeMatch[1] ?? "");
        const response = input.backend.getCardRuntime(cardQuery);
        writeJson(res, response.status, response.body);
        return;
      }

      const terminalInputMatch = url.pathname.match(
        /^\/kanban\/cards\/([^/]+)\/terminal\/input$/,
      );
      if (req.method === "POST" && terminalInputMatch) {
        const cardId = decodeURIComponent(terminalInputMatch[1] ?? "");
        const body = await parseJsonBody(req);
        const response = await handleTerminalInputRequest(
          body,
          (terminalInput) =>
            input.backend.sendTerminalInput(cardId, terminalInput),
        );
        writeJson(res, response.status, response.body);
        return;
      }

      const terminalMatch = url.pathname.match(
        /^\/kanban\/cards\/([^/]+)\/terminal\/stream$/,
      );
      if (req.method === "GET" && terminalMatch) {
        const cardId = decodeURIComponent(terminalMatch[1] ?? "");
        writeCorsHeaders(res);
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();

        const unsubscribe = input.backend.subscribeTerminalStream(
          cardId,
          (event) => {
            res.write(
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            );
          },
        );

        const ping = setInterval(() => {
          res.write(": ping\n\n");
        }, 15_000);

        req.on("close", () => {
          clearInterval(ping);
          unsubscribe();
        });
        return;
      }

      const contextMatch = url.pathname.match(
        /^\/kanban\/cards\/([^/]+)\/context$/,
      );
      if (req.method === "GET" && contextMatch) {
        const cardQuery = decodeURIComponent(contextMatch[1] ?? "");
        const response = input.backend.getCardContext(cardQuery);
        writeJson(res, response.status, response.body);
        return;
      }

      if (req.method === "GET" && url.pathname === "/kanban/board") {
        const response = input.backend.readBoard();
        writeJson(res, response.status, response.body);
        return;
      }

      if (req.method === "PATCH" && url.pathname === "/kanban/board") {
        const body = await parseJsonBody(req);
        const nextBoardText =
          typeof body.nextBoardText === "string" ? body.nextBoardText : "";

        const response = input.backend.patchBoard(nextBoardText);
        writeJson(res, response.status, response.body);
        return;
      }

      writeJson(res, 404, {
        error: `Not found: ${req.method ?? "GET"} ${url.pathname}`,
      });
    } catch (error) {
      writeJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return {
    async start() {
      if (server) return;

      server = http.createServer(requestHandler);
      await new Promise<void>((resolve, reject) => {
        server?.once("error", reject);
        server?.listen(input.port, input.host, () => {
          const address = server?.address();
          if (address && typeof address === "object") {
            startedPort = address.port;
          }
          resolve();
        });
      });
    },
    async stop() {
      if (!server) return;
      const current = server;
      server = null;
      await new Promise<void>((resolve, reject) => {
        current.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    get baseUrl() {
      return `http://${input.host}:${startedPort}`;
    },
  };
}
