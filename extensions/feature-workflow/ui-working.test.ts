import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { runWithWorkingLoader } from "./ui-working.js";

type LoaderComponent = {
  render: (width: number) => string[];
  dispose?: () => void;
};

type LoaderFactory = (
  tui: { requestRender(): void },
  theme: { fg(color: string, text: string): string },
  keybindings: unknown,
  done: (value: unknown) => void,
) => LoaderComponent;

function createUiCustomMock() {
  const renders: string[] = [];
  const custom = vi.fn(async (factory: LoaderFactory) => {
    let component: LoaderComponent | undefined;

    const result = await new Promise<unknown>((resolve) => {
      component = factory(
        { requestRender() {} },
        {
          fg(_color: string, text: string) {
            return text;
          },
        },
        {},
        (value: unknown) => resolve(value),
      );

      renders.push(component.render(80).join("\n"));
    });

    component?.dispose?.();
    return result;
  });

  return { custom, renders };
}

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
  });

  it("shows a bordered working loader and returns the workflow result in UI mode", async () => {
    const workflow = vi.fn(async () => "done");
    const { custom, renders } = createUiCustomMock();
    const ctx = {
      hasUI: true,
      ui: {
        custom,
      },
    } as unknown as ExtensionCommandContext;

    await expect(runWithWorkingLoader(ctx, workflow)).resolves.toBe("done");

    expect(workflow).toHaveBeenCalledTimes(1);
    expect(custom).toHaveBeenCalledTimes(1);
    expect(renders[0]).toContain("Working...");
    expect(renders[0]).toContain("⠋");
  });

  it("rethrows workflow errors after the loader closes", async () => {
    const error = new Error("boom");
    const workflow = vi.fn(async () => {
      throw error;
    });
    const { custom } = createUiCustomMock();
    const ctx = {
      hasUI: true,
      ui: {
        custom,
      },
    } as unknown as ExtensionCommandContext;

    await expect(runWithWorkingLoader(ctx, workflow)).rejects.toThrow("boom");

    expect(workflow).toHaveBeenCalledTimes(1);
    expect(custom).toHaveBeenCalledTimes(1);
  });
});
