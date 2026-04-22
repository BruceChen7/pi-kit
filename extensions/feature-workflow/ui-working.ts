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

export async function runWithWorkingLoader<T>(
  ctx: ExtensionCommandContext,
  workflow: () => Promise<T>,
): Promise<T> {
  if (!ctx.hasUI || typeof ctx.ui.custom !== "function") {
    return workflow();
  }

  const result = await ctx.ui.custom<WorkingLoaderResult<T>>(
    (tui, theme, _kb, done) => {
      const loader = new BorderedLoader(tui, theme, "Working...", {
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
