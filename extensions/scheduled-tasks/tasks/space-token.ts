import { defineTask } from "../../shared/deferred-queue/define-task.ts";

export default defineTask({
  id: "space-token-refresh",
  every: "2m",
  description: "Refresh SPACE platform token every 24 hours",
  handler: async (exec) => {
    await exec.exec("opencli", [
      "space",
      "user-token",
      "--write",
      "~/.space/token",
    ]);
  },
});
