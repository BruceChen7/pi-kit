// Mirrors the staleness error thrown by pi's extension loader
// (`createExtensionRuntime().assertActive`) when a captured `pi` or command
// `ctx` is used after session replacement or reload (newSession, fork,
// switchSession, reload). Long-lived callbacks (sockets, timers, watchers)
// that outlive their owning session must treat this error as "the session is
// gone" and drop their work instead of letting it crash pi.
const STALE_SESSION_CONTEXT_MESSAGE =
  "This extension ctx is stale after session replacement or reload.";

export function isStaleSessionContextError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(STALE_SESSION_CONTEXT_MESSAGE)
  );
}
