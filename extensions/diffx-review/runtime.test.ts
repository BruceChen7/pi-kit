import { describe, expect, it } from "vitest";

import { buildDiffxStartCommand } from "./runtime.ts";

describe("diffx-review runtime", () => {
  it("prefers the configured diffx command", () => {
    const command = buildDiffxStartCommand({
      repoRoot: "/tmp/repo",
      diffxCommand: "diffx",
      diffxPath: "/tmp/diffx",
      host: "127.0.0.1",
      port: 3433,
      openInBrowser: false,
      diffArgs: ["main..HEAD"],
      startupTimeoutMs: 15000,
    });

    expect(command).toEqual({
      command: "diffx",
      args: [
        "--host",
        "127.0.0.1",
        "--port",
        "3433",
        "--no-open",
        "--",
        "main..HEAD",
      ],
      description: "diffx --host 127.0.0.1 --port 3433 --no-open -- main..HEAD",
    });
  });

  it("supports multi-token commands like npx diffx-cli", () => {
    const command = buildDiffxStartCommand({
      repoRoot: "/tmp/repo",
      diffxCommand: "npx diffx-cli",
      diffxPath: "/tmp/diffx",
      host: "0.0.0.0",
      port: null,
      openInBrowser: true,
      diffArgs: [],
      startupTimeoutMs: 15000,
    });

    expect(command).toEqual({
      command: "npx",
      args: ["diffx-cli", "--host", "0.0.0.0"],
      description: "npx diffx-cli --host 0.0.0.0",
    });
  });

  it("falls back to local dist mode when no command is configured", () => {
    const command = buildDiffxStartCommand({
      repoRoot: "/tmp/repo",
      diffxCommand: null,
      diffxPath: "/tmp/diffx",
      host: "127.0.0.1",
      port: null,
      openInBrowser: true,
      diffArgs: ["--cached"],
      startupTimeoutMs: 15000,
    });

    expect(command).toEqual({
      command: "node",
      args: [
        "/tmp/diffx/dist/cli.mjs",
        "--host",
        "127.0.0.1",
        "--",
        "--cached",
      ],
      description: "node /tmp/diffx/dist/cli.mjs --host 127.0.0.1 -- --cached",
    });
  });
});
