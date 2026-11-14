import { describe, expect, it } from "vitest";
import { stripHeredocBodies } from "./shell-text.js";

describe("stripHeredocBodies", () => {
  it("drops the body of a quoted heredoc", () => {
    const command = [
      "cat >> notes.test.ts <<'EOF'",
      "",
      'it("rm 章节文件", () => {',
      "});",
      "EOF",
      "echo done",
    ].join("\n");

    expect(stripHeredocBodies(command)).toBe(
      "cat >> notes.test.ts <<'EOF'\necho done",
    );
  });

  it("keeps text that only looks like a heredoc opener", () => {
    const command = 'echo "a << b"';
    expect(stripHeredocBodies(command)).toBe(command);
  });

  it("drops an indented body for `<<-`", () => {
    const command = [
      "cat > /tmp/x.sh <<-'EOF'",
      "\tsleep 30",
      "\tEOF",
      "bash /tmp/x.sh",
    ].join("\n");

    expect(stripHeredocBodies(command)).toBe(
      "cat > /tmp/x.sh <<-'EOF'\nbash /tmp/x.sh",
    );
  });
});
