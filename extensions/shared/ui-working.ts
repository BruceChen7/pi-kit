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

type WorkingLoaderOptions = {
  message?: string;
};

export async function runWithWorkingLoader<T>(
  ctx: ExtensionCommandContext,
  workflow: () => Promise<T>,
  options: WorkingLoaderOptions = {},
): Promise<T> {
  if (!ctx.hasUI || typeof ctx.ui.custom !== "function") {
    return workflow();
  }

  const { message = "Working..." } = options;
  const result = await ctx.ui.custom<WorkingLoaderResult<T>>(
    (tui, theme, _kb, done) => {
      const loader = new BorderedLoader(tui, theme, message, {
        cancellable: false,
      });

      void workflow()
        .then((value) => done({ ok: true, value }))
        .catch((error: unknown) => done({ ok: false, error }));

      return loader;
    },
  );

  if (!result.ok) {
    throw result.error;
  }

  return result.value;
}
