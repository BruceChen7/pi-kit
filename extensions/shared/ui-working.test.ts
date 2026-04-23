import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  BorderedLoader: vi.fn(),
}));

vi.mock("@mariozechner/pi-coding-agent", async () => {
  const actual = await vi.importActual<
    typeof import("@mariozechner/pi-coding-agent")
  >("@mariozechner/pi-coding-agent");

  return {
    ...actual,
    BorderedLoader: mocks.BorderedLoader,
  };
});

import { runWithWorkingLoader } from "./ui-working.js";

type LoaderFactory = (
  tui: { requestRender(): void },
  theme: { fg(color: string, text: string): string },
  keybindings: unknown,
  done: (value: unknown) => void,
) => unknown;

function createUiCustomStub() {
  const custom = vi.fn(async (factory: LoaderFactory) => {
    return new Promise<unknown>((resolve) => {
      factory(
        { requestRender() {} },
        {
          fg(_color: string, text: string) {
            return text;
          },
        },
        {},
        (value: unknown) => resolve(value),
      );
    });
  });

  return { custom };
}

beforeEach(() => {
  mocks.BorderedLoader.mockReset();
  mocks.BorderedLoader.mockImplementation(() => ({
    dispose() {},
  }));
});

describe("runWithWorkingLoader", () => {
  it("runs the workflow directly when no UI is available", async () => {
    const workflow = vi.fn(async () => "done");
    const custom = vi.fn();
    const ctx = {
      hasUI: false,
      ui: {
        custom,
      },
    } as unknown as ExtensionCommandContext;

    await expect(runWithWorkingLoader(ctx, workflow)).resolves.toBe("done");

    expect(workflow).toHaveBeenCalledTimes(1);
    expect(custom).not.toHaveBeenCalled();
    expect(mocks.BorderedLoader).not.toHaveBeenCalled();
  });

  it("creates the default working loader and returns the workflow result in UI mode", async () => {
    const workflow = vi.fn(async () => "done");
    const { custom } = createUiCustomStub();
    const ctx = {
      hasUI: true,
      ui: {
        custom,
      },
    } as unknown as ExtensionCommandContext;

    await expect(runWithWorkingLoader(ctx, workflow)).resolves.toBe("done");

    expect(workflow).toHaveBeenCalledTimes(1);
    expect(custom).toHaveBeenCalledTimes(1);
    expect(mocks.BorderedLoader).toHaveBeenCalledTimes(1);
    expect(mocks.BorderedLoader).toHaveBeenCalledWith(
      expect.objectContaining({ requestRender: expect.any(Function) }),
      expect.objectContaining({ fg: expect.any(Function) }),
      "Working...",
      { cancellable: false },
    );
  });

  it("lets callers dismiss the loader before the original custom view becomes stale", async () => {
    let stale = false;
    const custom = vi.fn(async (factory: LoaderFactory) => {
      return new Promise<unknown>((resolve, reject) => {
        factory(
          { requestRender() {} },
          {
            fg(_color: string, text: string) {
              return text;
            },
          },
          {},
          (value: unknown) => {
            if (stale) {
              reject(
                new Error(
                  "This extension instance is stale after session replacement or reload. Use the provided replacement-session context instead.",
                ),
              );
              return;
            }
            resolve(value);
          },
        );
      });
    });
    const ctx = {
      hasUI: true,
      ui: {
        custom,
      },
    } as unknown as ExtensionCommandContext;
    const workflow = vi.fn(async (controls: { dismiss: () => void }) => {
      controls.dismiss();
      stale = true;
      return "done";
    });

    await expect(runWithWorkingLoader(ctx, workflow)).resolves.toBe("done");

    expect(workflow).toHaveBeenCalledTimes(1);
    expect(custom).toHaveBeenCalledTimes(1);
  });

  it("uses a caller-provided loader message when supplied", async () => {
    const workflow = vi.fn(async () => "done");
    const { custom } = createUiCustomStub();
    const ctx = {
      hasUI: true,
      ui: {
        custom,
      },
    } as unknown as ExtensionCommandContext;

    await expect(
      runWithWorkingLoader(ctx, workflow, { message: "Cleaning..." }),
    ).resolves.toBe("done");

    expect(mocks.BorderedLoader).toHaveBeenCalledWith(
      expect.objectContaining({ requestRender: expect.any(Function) }),
      expect.objectContaining({ fg: expect.any(Function) }),
      "Cleaning...",
      { cancellable: false },
    );
  });

  it("rethrows workflow errors after the loader closes", async () => {
    const error = new Error("boom");
    const workflow = vi.fn(async () => {
      throw error;
    });
    const { custom } = createUiCustomStub();
    const ctx = {
      hasUI: true,
      ui: {
        custom,
      },
    } as unknown as ExtensionCommandContext;

    await expect(runWithWorkingLoader(ctx, workflow)).rejects.toThrow("boom");

    expect(workflow).toHaveBeenCalledTimes(1);
    expect(custom).toHaveBeenCalledTimes(1);
    expect(mocks.BorderedLoader).toHaveBeenCalledTimes(1);
  });
});
