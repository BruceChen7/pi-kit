/**
 * opencli-output.ts — parse the result envelope that `opencli` prints.
 *
 * opencli 2.x wraps every command result in a result envelope:
 *
 *     {"ok": true,  "data": [...]}
 *     {"ok": false, "error": {"code": "...", "message": "..."}}
 *
 * opencli 1.x printed the payload bare. Both shapes reach the tasks, because
 * the vendored `node_modules` copy and the globally installed CLI upgrade
 * independently, so the envelope is parsed here rather than assumed away.
 *
 * This is a system boundary: the CLI is a third party whose output shape is
 * not ours to trust. Everything downstream receives typed data.
 */

/** The `error` object opencli puts in a failed envelope. */
interface OpencliError {
  code?: unknown;
  message?: unknown;
}

export const parseOpencliArray = <T>(jsonString: string): T[] => {
  const parsed: unknown = JSON.parse(jsonString);

  if (Array.isArray(parsed)) {
    return parsed as T[];
  }

  if (parsed && typeof parsed === "object") {
    const envelope = parsed as {
      ok?: unknown;
      data?: unknown;
      error?: unknown;
    };

    if (envelope.ok === false) {
      const error = (envelope.error ?? {}) as OpencliError;
      const code =
        typeof error.code === "string" ? error.code : "unknown_error";
      const message =
        typeof error.message === "string"
          ? error.message
          : JSON.stringify(envelope.error);
      throw new Error(`opencli reported ${code}: ${message}`);
    }

    if ("data" in envelope) {
      if (Array.isArray(envelope.data)) {
        return envelope.data as T[];
      }
      throw new Error(
        `Expected JSON array from opencli, got data of type ${typeof envelope.data}`,
      );
    }
  }

  throw new Error(`Expected JSON array from opencli, got ${typeof parsed}`);
};
