import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const workDir = path.resolve(os.homedir(), "work");

export default function (pi: ExtensionAPI) {
  pi.on("project_trust", async (event, _ctx) => {
    // Auto-trust any project under ~/work/ (recursive, any depth).
    if (event.cwd === workDir || event.cwd.startsWith(workDir + path.sep)) {
      return { trusted: "yes" };
    }

    // For paths outside ~/work, let the built-in trust flow decide.
    return { trusted: "undecided" };
  });
}
