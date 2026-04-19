import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { registerDiffxReviewCommands } from "./commands.ts";
import { registerDiffxReviewTools } from "./tools.ts";

export default function diffxReviewExtension(pi: ExtensionAPI) {
  registerDiffxReviewCommands(pi);
  registerDiffxReviewTools(pi);
}
