import { createLogger } from "../logger.ts";

/**
 * Shared logger for the deferred-queue framework and its tasks.
 * All log output goes to ~/.pi/agent/pi-debug.log only (stderr disabled).
 */
export const log = createLogger("deferred-queue", { stderr: null });
