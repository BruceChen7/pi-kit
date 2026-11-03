import { describe, expect, it } from "vitest";
import { signIn } from "./auth.js";
import { defaultConfigPath, readConfig } from "./index.js";
import type { Pending } from "./messages.js";
import { connectWatch } from "./watch.js";

/**
 * Gate 3: the push path, end to end, against a running doop.
 *
 *   DOOP_EMAIL=… DOOP_PASSWORD=… DOOP_CANVAS_ID=… \
 *     npx vitest run extensions/doop/live-watch.test.ts
 *
 * It creates a frame and a comment on that canvas through the same endpoints
 * the app uses, then waits for the WebSocket to deliver the comment.
 */
const password = process.env.DOOP_PASSWORD?.trim();
const loaded = readConfig(defaultConfigPath());
const config = loaded.ok
  ? loaded.config
  : {
      baseUrl: "http://localhost:4300",
      agentKey: "",
      agentName: "pi",
      watch: false,
      cards: false,
    };
const email = process.env.DOOP_EMAIL?.trim() || "pi-probe@local.test";
const canvasId = process.env.DOOP_CANVAS_ID?.trim() || config.canvasId || "";

type McpPayload = Record<string, unknown>;

async function mcpTool(
  name: string,
  args: Record<string, unknown>,
): Promise<McpPayload> {
  const response = await fetch(`${config.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.agentKey}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const body = (await response.json()) as {
    result?: { content?: { text?: string }[] };
    error?: { message?: string };
  };
  const text = body.result?.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error(
      `mcp ${name} failed: ${body.error?.message ?? JSON.stringify(body).slice(0, 200)}`,
    );
  }
  return JSON.parse(text) as McpPayload;
}

async function postComment(
  cookie: string,
  frameId: string,
  text: string,
): Promise<string> {
  const response = await fetch(
    `${config.baseUrl}/api/frames/${frameId}/comments`,
    {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ text, elementId: "e2e", snippet: "<div></div>" }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `comment failed: HTTP ${response.status} ${await response.text()}`,
    );
  }
  const comment = (await response.json()) as { id?: string };
  if (!comment.id) throw new Error("comment came back without an id");
  return comment.id;
}

describe("live doop push", () => {
  it.skipIf(!password || !canvasId)(
    "delivers a new comment within 5 seconds",
    async () => {
      const signedIn = await signIn(config, {
        email,
        password: password ?? "",
      });
      expect(signedIn.ok).toBe(true);
      if (!signedIn.ok) return;

      const frame = await mcpTool("create_frame", {
        canvas_id: canvasId,
        name: "e2e push",
        html: "<div style='padding:16px'>e2e</div>",
        agent_name: config.agentName,
      });
      const summary =
        typeof frame.frame === "object" && frame.frame !== null
          ? (frame.frame as McpPayload)
          : frame;
      const frameId = typeof summary.id === "string" ? summary.id : "";
      expect(frameId).not.toBe("");

      const pending: Pending[] = [];
      const states: string[] = [];
      const watch = connectWatch({
        baseUrl: config.baseUrl,
        canvasId,
        cookie: signedIn.record.cookie,
        agentName: config.agentName,
        onPending: (item) => pending.push(item),
        onState: (state) => states.push(state),
      });

      try {
        await waitFor(() => states.includes("live"), 10_000);
        const commentId = await postComment(
          signedIn.record.cookie,
          frameId,
          "e2e: does this comment arrive over the socket?",
        );
        await waitFor(
          () => pending.some((item) => item.id === commentId),
          5_000,
        );
        const item = pending.find((entry) => entry.id === commentId);
        expect(item).toMatchObject({ kind: "comment", frameId });

        await mcpTool("resolve_comment", {
          canvas_id: canvasId,
          comment_id: commentId,
          agent_name: config.agentName,
        });
      } finally {
        watch.stop();
        await mcpTool("delete_frame", {
          frame_id: frameId,
          agent_name: config.agentName,
        }).catch(() => undefined);
      }
    },
    40_000,
  );
});

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
