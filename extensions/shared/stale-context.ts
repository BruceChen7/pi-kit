// Mirrors the staleness error thrown by pi's extension runtime
// (`createExtensionRuntime().assertActive`, dist/core/extensions/runner.js)
// when a captured `pi` or command `ctx` is used after session replacement or
// reload (newSession, fork, switchSession, reload). Long-lived callbacks
// (sockets, timers, watchers) that outlive their owning session must treat
// this error as "the session is gone" and drop their work instead of letting
// it crash pi.
//
// pi throws a plain `Error`, so the check matches the stable message prefix
// rather than the full sentence: the prefix is the documented contract, while
// the tail ("Do not use a captured pi or command ctx ...") may reword between
// releases. Use `startsWith`, not `includes`, so the long tail cannot break
// the match.
const STALE_SESSION_CONTEXT_PREFIX =
  "This extension ctx is stale after session replacement or reload.";

export function isStaleSessionContextError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith(STALE_SESSION_CONTEXT_PREFIX)
  );
}
