import { describe, expect, it, vi } from "vitest";
import { createLoggerReady } from "./index.js";

describe("createLoggerReady", () => {
  it("waits for logger initialization to complete", async () => {
    let resolveInit: (() => void) | null = null;
    const init = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveInit = resolve;
        }),
    );

    const ready = createLoggerReady("/tmp/pi-kit", init);

    expect(init).toHaveBeenCalledWith("/tmp/pi-kit");

    let settled = false;
    void ready.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    resolveInit?.();
    await ready;
    expect(settled).toBe(true);
  });

  it("swallows logger initialization failures", async () => {
    const init = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(
      createLoggerReady("/tmp/pi-kit", init),
    ).resolves.toBeUndefined();
    expect(init).toHaveBeenCalledWith("/tmp/pi-kit");
  });
});
