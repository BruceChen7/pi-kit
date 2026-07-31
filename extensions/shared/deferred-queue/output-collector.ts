/**
 * Bounded accumulator for child-process stdout/stderr.
 *
 * Guards the host process against unbounded output growth: naive
 * `stdout += chunk` accumulation throws `RangeError: Invalid string length`
 * once the result exceeds V8's maximum string length (~536M chars), which
 * crashes the host with an uncaughtException from inside the Socket data
 * listener. `push` never throws — on overflow it truncates the buffer, marks
 * the collector, and returns `false` so the caller can terminate the child.
 */
export interface OutputCollector {
  /**
   * Append a chunk. Returns `false` once the cap is hit and output has been
   * dropped (further pushes are no-ops).
   */
  push(chunk: string): boolean;
  /** Collected text, never longer than `limitChars`. */
  readonly value: string;
  /** True once the cap has been reached and output was dropped. */
  readonly truncated: boolean;
}

export function createOutputCollector(limitChars: number): OutputCollector {
  let value = "";
  let truncated = false;

  return {
    get value() {
      return value;
    },
    get truncated() {
      return truncated;
    },
    push(chunk) {
      if (truncated) return false;
      try {
        const room = Math.max(0, limitChars - value.length);
        if (chunk.length <= room) {
          value += chunk;
          return true;
        }
        value += chunk.slice(0, room);
        truncated = true;
        return false;
      } catch {
        // Never let an accumulation failure escape the data listener.
        truncated = true;
        return false;
      }
    },
  };
}

/**
 * Wire a readable stream (child stdout/stderr, PassThrough, ...) to a
 * collector. The overflow handling is delegated to `onTruncated` so the
 * kill/log decision stays in the shell while the wiring itself stays
 * testable with in-memory streams. Accepts `null` streams (child process
 * stdio pipes are typed nullable) and treats them as no-ops.
 */
export function bindCollector(
  stream: NodeJS.ReadableStream | null,
  collector: OutputCollector,
  onTruncated: () => void,
): void {
  if (!stream) return;
  let notified = false;
  stream.on("data", (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString();
    if (!collector.push(text) && !notified) {
      notified = true;
      onTruncated();
    }
  });
}
