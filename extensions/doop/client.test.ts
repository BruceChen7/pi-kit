import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { callTool, getComments } from "./client.js";
import type { DoopConfig } from "./config.js";

type Reply = { status: number; body: string };

type Harness = {
  baseUrl: string;
  /** every request body the stub received, in order */
  requests: { authorization?: string; body: Record<string, unknown> }[];
  close: () => Promise<void>;
};

const open: Harness[] = [];

async function stubServer(replies: Reply[]): Promise<Harness> {
  const queue = [...replies];
  const requests: Harness["requests"] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      requests.push({
        ...(req.headers.authorization
          ? { authorization: req.headers.authorization }
          : {}),
        body: raw ? JSON.parse(raw) : {},
      });
      const reply = queue.shift() ?? { status: 500, body: "exhausted" };
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const harness: Harness = {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
  open.push(harness);
  return harness;
}

afterEach(async () => {
  while (open.length > 0) {
    const harness = open.pop();
    if (harness) await harness.close();
  }
});

function config(baseUrl: string): DoopConfig {
  return {
    baseUrl,
    agentKey: "dpk_test_key",
    canvasId: "U43rjP-JxT",
    agentName: "pi",
  };
}

function toolResult(payload: unknown, isError = false): Reply {
  return {
    status: 200,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        ...(isError ? { isError: true } : {}),
      },
    }),
  };
}

function proseResult(message: string, isError = true): Reply {
  return {
    status: 200,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: message }],
        ...(isError ? { isError: true } : {}),
      },
    }),
  };
}

const COMMENT = {
  id: "c1",
  text: "solid CTA",
  from: "rich",
  at: 1,
  frameId: "f1",
  elementId: "cta",
  html: "<button>Book</button>",
};

describe("callTool", () => {
  it("posts one MCP tools/call with the agent key", async () => {
    const server = await stubServer([toolResult([COMMENT])]);
    const result = await callTool(config(server.baseUrl), "get_comments", {
      canvas_id: "U43rjP-JxT",
    });
    expect(result.ok).toBe(true);
    expect(server.requests).toHaveLength(1);
    const [request] = server.requests;
    expect(request?.authorization).toBe("Bearer dpk_test_key");
    expect(request?.body).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "get_comments", arguments: { canvas_id: "U43rjP-JxT" } },
    });
  });

  it("maps 401 to an auth error that names the next step", async () => {
    const server = await stubServer([{ status: 401, body: "nope" }]);
    const result = await callTool(config(server.baseUrl), "get_comments", {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("auth");
    expect(result.error.message).toContain("Settings -> Agent keys");
  });

  it("retries a 5xx once and keeps the second answer", async () => {
    const server = await stubServer([
      { status: 503, body: "busy" },
      toolResult([COMMENT]),
    ]);
    const result = await callTool(
      config(server.baseUrl),
      "get_comments",
      {},
      { retryDelayMs: 0 },
    );
    expect(result.ok).toBe(true);
    expect(server.requests).toHaveLength(2);
  });

  it("gives up after the retry and says how to start doop", async () => {
    const server = await stubServer([
      { status: 500, body: "boom" },
      { status: 500, body: "boom" },
    ]);
    const result = await callTool(
      config(server.baseUrl),
      "get_comments",
      {},
      { retryDelayMs: 0, timeoutMs: 2000 },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unavailable");
    expect(result.error.message).toContain("bun run dev");
  });

  it("treats an unreachable host as unavailable", async () => {
    const result = await callTool(
      config("http://127.0.0.1:1"),
      "get_comments",
      {},
      { retryDelayMs: 0, timeoutMs: 500 },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unavailable");
  });

  it("maps a doop isError result to a canvas error with the prose", async () => {
    const server = await stubServer([
      proseResult("Error: no canvas with id nope"),
    ]);
    const result = await callTool(config(server.baseUrl), "get_comments", {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("canvas");
    expect(result.error.message).toBe("no canvas with id nope");
  });

  it("reports content that is not JSON as a protocol error", async () => {
    const server = await stubServer([proseResult("half a sentence", false)]);
    const result = await callTool(config(server.baseUrl), "get_comments", {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("protocol");
  });

  it("reports a result with no content as a protocol error", async () => {
    const server = await stubServer([
      {
        status: 200,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
      },
    ]);
    const result = await callTool(config(server.baseUrl), "get_comments", {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("protocol");
  });
});

describe("getComments", () => {
  it("asks for unresolved comments of the bound canvas as the bound agent", async () => {
    const server = await stubServer([toolResult([COMMENT])]);
    const result = await getComments(config(server.baseUrl), "U43rjP-JxT");
    expect(result.ok).toBe(true);
    expect(server.requests[0]?.body).toMatchObject({
      params: {
        name: "get_comments",
        arguments: {
          canvas_id: "U43rjP-JxT",
          include_resolved: false,
          agent_name: "pi",
        },
      },
    });
  });

  it("parses the payload into comments", async () => {
    const server = await stubServer([toolResult([COMMENT, { id: "half" }])]);
    const result = await getComments(config(server.baseUrl), "U43rjP-JxT");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((c) => c.id)).toEqual(["c1"]);
  });

  it("refuses a payload where every comment is malformed", async () => {
    const server = await stubServer([toolResult([{ id: 42 }])]);
    const result = await getComments(config(server.baseUrl), "U43rjP-JxT");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("protocol");
  });
});
