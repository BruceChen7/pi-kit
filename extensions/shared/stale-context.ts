const STALE_SESSION_CONTEXT_MESSAGE =
  "This extension instance is stale after session replacement or reload.";

export function isStaleSessionContextError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(STALE_SESSION_CONTEXT_MESSAGE)
  );
}
