import {
  BorderedLoader,
  type ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

type WorkingLoaderResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      error: unknown;
    };

type WorkingLoaderDismissedResult = {
  dismissed: true;
};

export type WorkingLoaderControls = {
  dismiss: () => void;
};

type WorkingLoaderOptions = {
  message?: string;
};

export async function runWithWorkingLoader<T>(
  ctx: ExtensionCommandContext,
  workflow: (controls: WorkingLoaderControls) => Promise<T>,
  options: WorkingLoaderOptions = {},
): Promise<T> {
  const controls: WorkingLoaderControls = {
    dismiss() {
      // no-op without a custom loader
    },
  };

  if (!ctx.hasUI || typeof ctx.ui.custom !== "function") {
    return workflow(controls);
  }

  const { message = "Working..." } = options;
  let closeLoader:
    | ((result: WorkingLoaderResult<T> | WorkingLoaderDismissedResult) => void)
    | null = null;
  let loaderClosed = false;
  let workflowPromise: Promise<WorkingLoaderResult<T>> | null = null;

  const finishLoader = (
    result: WorkingLoaderResult<T> | WorkingLoaderDismissedResult,
  ): void => {
    if (loaderClosed) {
      return;
    }

    loaderClosed = true;
    closeLoader?.(result);
  };

  controls.dismiss = () => {
    finishLoader({ dismissed: true });
  };

  const uiResult = await ctx.ui.custom<
    WorkingLoaderResult<T> | WorkingLoaderDismissedResult
  >((tui, theme, _kb, done) => {
    closeLoader = done;

    const loader = new BorderedLoader(tui, theme, message, {
      cancellable: false,
    });

    workflowPromise = (async (): Promise<WorkingLoaderResult<T>> => {
      try {
        const value = await workflow(controls);
        const result = { ok: true, value } as const;
        finishLoader(result);
        return result;
      } catch (error: unknown) {
        const result = { ok: false, error } as const;
        finishLoader(result);
        return result;
      }
    })();

    return loader;
  });

  const result = "dismissed" in uiResult ? await workflowPromise : uiResult;
  if (!result) {
    throw new Error("Working loader finished without a workflow result.");
  }

  if (!result.ok) {
    throw result.error;
  }

  return result.value;
}
