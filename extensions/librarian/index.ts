/* biome-ignore-all lint/suspicious/noExplicitAny: GitHub API and pi JSON event payloads are intentionally dynamic at this adapter boundary. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGithubTools } from "./github.js";
import { registerGitlabTools } from "./gitlab.js";
import { registerLibrarianGithub } from "./librarian-github.js";
import { registerLibrarianGitlab } from "./librarian-gitlab.js";

// Re-export commonly-used utilities for testing and backward compat
export { parseRepository, summarizeGithubToolCall } from "./github.js";
export { parseGitLabProject, summarizeGitlabToolCall } from "./gitlab.js";
export {
  asTextResult,
  formatDuration,
  formatNumberedFileContent,
  globMatches,
  normalizePath,
  sanitizeDisplayText,
  sanitizeParamValue,
  stripAnsiAndControl,
  toolErrorResult,
  truncateInline,
  validateSearchPattern,
} from "./shared.js";

export default function (pi: ExtensionAPI) {
  registerGithubTools(pi);
  registerGitlabTools(pi);
  registerLibrarianGithub(pi);
  registerLibrarianGitlab(pi);
}
