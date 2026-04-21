import { describe, expect, it, vi } from "vitest";

import { waitForBootstrapReady } from "./bootstrap";

describe("waitForBootstrapReady", () => {
  it("polls until bootstrap becomes ready", async () => {
    const bootstrap = vi
      .fn<
        () => Promise<
          | { status: "pending"; retryAfterMs: number }
          | { status: "ready"; sessionId: string }
        >
      >()
      .mockResolvedValueOnce({
        status: "pending",
        retryAfterMs: 25,
      })
      .mockResolvedValueOnce({
        status: "ready",
        sessionId: "workspace:workspace-kanban-drive",
      });
    const sleep = vi.fn(async () => {});

    const result = await waitForBootstrapReady({ bootstrap, sleep });

    expect(result).toEqual({
      status: "ready",
      sessionId: "workspace:workspace-kanban-drive",
    });
    expect(bootstrap).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(25);
  });

  it("throws when bootstrap returns failed", async () => {
    const bootstrap = vi.fn(async () => ({
      status: "failed" as const,
      error: "runtime unavailable",
    }));

    await expect(
      waitForBootstrapReady({
        bootstrap,
        sleep: async () => {},
      }),
    ).rejects.toThrow("runtime unavailable");
  });
});
