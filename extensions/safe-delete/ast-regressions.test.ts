import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

const loadSafeDelete = async () => (await import("./safe-delete.ts")).default;

type Hook = (
  event: { toolName: string; input: { command: string } },
  ctx: unknown,
) => Promise<{ block?: boolean; reason?: string } | undefined>;

const runHook = async (command: string) => {
  const handlers = new Map<string, Hook>();
  const safeDelete = await loadSafeDelete();
  safeDelete({
    on(name: string, handler: Hook) {
      handlers.set(name, handler);
    },
    events: { emit: vi.fn() },
  } as unknown as ExtensionAPI);

  const confirm = vi.fn(async () => false);
  const ctx = {
    cwd: "/work/pi-kit",
    hasUI: true,
    ui: { confirm },
    sessionManager: { getEntries: () => [] },
  };
  const result = await handlers.get("tool_call")?.(
    { toolName: "bash", input: { command } },
    ctx,
  );
  return { result, confirm };
};

describe("safe-delete: wrappers cannot hide a deletion", () => {
  it.each([
    ["sh -c", "sh -c 'rm -rf /'"],
    ["bash -lc", "bash -lc 'rm -rf /'"],
    ["eval", 'eval "rm -rf /"'],
    ["sudo sh -c", "sudo sh -c 'rm -rf /'"],
    ["xargs", "sudo xargs -0 rm -rf /"],
    ["find -exec", "find . -exec rm -rf / {} \\;"],
  ])("confirms a deletion behind %s", async (_label, command) => {
    const { result, confirm } = await runHook(command);

    expect(confirm).toHaveBeenCalled();
    expect(result?.block).toBe(true);
    expect(result?.reason ?? "").toContain(
      "Deletion targets protected path: /",
    );
  });

  it("escalates a wrapped deletion to critical", async () => {
    const { confirm } = await runHook("sudo sh -c 'rm -rf /'");
    const calls = confirm.mock.calls as unknown as Array<
      [string, ...unknown[]]
    >;
    const title = calls[0]?.[0];
    expect(title).toBe("CRITICAL: Destructive command detected");
  });
});

describe("safe-delete: existing detectors survive the AST rewrite", () => {
  it.each([
    ["git clean -fdx", "Aggressive git clean"],
    ["chmod -R 777 /etc", "Recursive chmod on protected path"],
    ["find / -delete", "find -delete rooted at protected path"],
    ["> /etc", "Truncation of protected file"],
    ["dd if=/dev/zero of=/dev/disk2", "dd writing directly to a device"],
    ["mv secret /dev/null", "mv to /dev/null"],
    ["rm -rf /*", "Wildcard deletion"],
    ["sudo rm -rf /", "[sudo] Deletion targets protected path"],
  ])("still confirms %s", async (command, expected) => {
    const { result } = await runHook(command);
    expect(result?.block).toBe(true);
    expect(result?.reason ?? "").toContain(expected);
  });
});

describe("safe-delete: no new false positives", () => {
  it.each([
    "npm format",
    "echo x > /etc/passwd",
    'echo "rm -rf /"',
    ["cat > /tmp/note.md <<'EOF'", "rm -rf / is a test title", "EOF"].join(
      "\n",
    ),
  ])("leaves %s alone", async (command) => {
    const { result, confirm } = await runHook(command);
    expect(result).toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
  });
});
