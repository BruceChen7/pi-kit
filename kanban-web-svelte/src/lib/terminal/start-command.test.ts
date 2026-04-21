import { describe, expect, it } from "vitest";

import { buildDefaultStartCommand } from "./start-command";

describe("buildDefaultStartCommand", () => {
  it("wraps prompts in double quotes", () => {
    expect(buildDefaultStartCommand("ship the feature")).toBe(
      'pi "ship the feature"',
    );
  });

  it("escapes quotes, shell interpolation characters, and newlines", () => {
    expect(buildDefaultStartCommand('say "$HOME" and `pwd`\nnow')).toBe(
      'pi "say \\"\\$HOME\\" and \\`pwd\\`\\nnow"',
    );
  });
});
