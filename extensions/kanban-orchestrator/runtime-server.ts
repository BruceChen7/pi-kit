import http from "node:http";

import {
  handleActionStatusRequest,
  handleActionStreamSubscribe,
  handleBoardPatchRequest,
  handleBoardReadRequest,
  handleBootstrapRequest,
  handleCardContextRequest,
  handleCardRuntimeRequest,
  handleExecuteActionRequest,
  handleTerminalStreamSubscribe,
} from "./api-routes.js";
import type { ResolveKanbanCardContextResult } from "./context.js";
import type { KanbanOrchestratorService } from "./service.js";

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

export function createKanbanRuntimeServer(input: {
  host: string;
  port: number;
  token: string;
  workspaceId: string;
  service: KanbanOrchestratorService;
  resolveContext: (cardQuery: string) => ResolveKanbanCardContextResult;
  applyBoardPatch: (
    nextBoardText: string,
  ) => { ok: true; summary: string } | { ok: false; error: string };
  readBoard: () => {
    path: string;
    lanes: unknown[];
    cards: unknown[];
    errors: string[];
  };
}): KanbanRuntimeServer {
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

      const unsubscribeState = handleActionStreamSubscribe(
        input.service,
        (state) => {
          res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
        },
      );
      const unsubscribeLifecycle = input.service.subscribeLifecycle((event) => {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      });

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
        const response = handleExecuteActionRequest(input.service, body, {
          resolveContext: input.resolveContext,
        });
        writeJson(res, response.status, response.body);
        return;
      }

      const actionMatch = url.pathname.match(/^\/kanban\/actions\/([^/]+)$/);
      if (req.method === "GET" && actionMatch) {
        const requestId = decodeURIComponent(actionMatch[1] ?? "");
        const response = handleActionStatusRequest(input.service, requestId);
        writeJson(res, response.status, response.body);
        return;
      }

      const runtimeMatch = url.pathname.match(
        /^\/kanban\/cards\/([^/]+)\/runtime$/,
      );
      if (req.method === "GET" && runtimeMatch) {
        const cardQuery = decodeURIComponent(runtimeMatch[1] ?? "");
        const response = handleCardRuntimeRequest(
          cardQuery,
          input.service,
          input.resolveContext,
          (cardId) =>
            `/kanban/cards/${encodeURIComponent(cardId)}/terminal/stream`,
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

        const unsubscribe = handleTerminalStreamSubscribe(
          input.service,
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
        const response = handleCardContextRequest(
          cardQuery,
          input.resolveContext,
        );
        writeJson(res, response.status, response.body);
        return;
      }

      if (req.method === "GET" && url.pathname === "/kanban/board") {
        const response = handleBoardReadRequest(input.readBoard);
        writeJson(res, response.status, response.body);
        return;
      }

      if (req.method === "PATCH" && url.pathname === "/kanban/board") {
        const body = await parseJsonBody(req);
        const nextBoardText =
          typeof body.nextBoardText === "string" ? body.nextBoardText : "";

        const response = handleBoardPatchRequest(() =>
          input.applyBoardPatch(nextBoardText),
        );
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
