import {
  BorderedLoader,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { hasRichUi } from "./rich-ui.ts";

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
  signal: AbortSignal;
};

type WorkingLoaderOptions = {
  message?: string;
  cancellable?: boolean;
};

export async function runWithWorkingLoader<T>(
  ctx: ExtensionCommandContext,
  workflow: (controls: WorkingLoaderControls) => Promise<T>,
  options: WorkingLoaderOptions = {},
): Promise<T> {
  const { message = "Working...", cancellable = false } = options;

  // Headless fallback: no component UI, run workflow directly with a
  // never-aborted signal. `hasRichUi` keeps the RPC transport out — there
  // `custom()` answers `undefined` instead of showing anything.
  if (!hasRichUi(ctx)) {
    const signal = new AbortController().signal;
    return workflow({ dismiss() {}, signal });
  }

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

  const controls: WorkingLoaderControls = {
    dismiss() {
      finishLoader({ dismissed: true });
    },
    signal: undefined as unknown as AbortSignal,
  };

  const uiResult = await ctx.ui.custom<
    WorkingLoaderResult<T> | WorkingLoaderDismissedResult
  >((tui, theme, _kb, done) => {
    closeLoader = done;

    const loader = new BorderedLoader(tui, theme, message, {
      cancellable,
    });

    if (cancellable) {
      loader.onAbort = () => done({ dismissed: true });
    }

    controls.signal = loader.signal;

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

  const reportResult = (r: WorkingLoaderResult<T>): T => {
    if ("error" in r) throw r.error;
    return r.value;
  };

  // A host that cannot draw the loader answers with `undefined` and never runs
  // the factory, so the workflow has not started yet: run it here, headless.
  if (uiResult === undefined) {
    const signal = new AbortController().signal;
    return workflow({ dismiss() {}, signal });
  }

  return reportResult(
    "dismissed" in uiResult
      ? await (workflowPromise as Promise<WorkingLoaderResult<T>>)
      : uiResult,
  );
}
