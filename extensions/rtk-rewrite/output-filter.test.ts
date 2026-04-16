import { describe, expect, it } from "vitest";
import {
  createOutputFilter,
  filterCommandOutput,
  isRegisteredCommand,
} from "./output-filter.js";

describe("isRegisteredCommand", () => {
  it("does not match when command list is empty", () => {
    expect(isRegisteredCommand("npm run build")).toBe(false);
    expect(isRegisteredCommand("cargo test -- --watch")).toBe(false);
  });

  it("matches configured command entries", () => {
    const commands = ["turbo build", "vitest"];
    expect(isRegisteredCommand("turbo build", commands)).toBe(true);
    expect(isRegisteredCommand("vitest run", commands)).toBe(true);
    expect(isRegisteredCommand("npm run lint", commands)).toBe(false);
  });

  it("matches configured commands wrapped by pi command", () => {
    expect(
      isRegisteredCommand("pi bash cargo test -- --watch", ["cargo test"]),
    ).toBe(true);
  });
});

describe("filterCommandOutput", () => {
  it("returns last N lines for matching commands", () => {
    const output = ["line 1", "line 2", "line 3", "line 4", "line 5"].join(
      "\n",
    );

    const result = filterCommandOutput(output, "cargo test", ["cargo test"], {
      maxLines: 2,
      maxChars: 1_000,
    });

    expect(result).toBe("line 4\nline 5");
  });

  it("applies maxChars after maxLines and keeps tail-most characters", () => {
    const output = ["first-line-12345", "second-line-ABCDE"].join("\n");

    const result = filterCommandOutput(output, "go test", ["go test"], {
      maxLines: 2,
      maxChars: 20,
    });

    expect(result).toBe("...[truncated]\nABCDE");
  });

  it("returns null when command is not in the configured list", () => {
    const result = filterCommandOutput(
      "output",
      "npm run build",
      ["cargo build"],
      {
        maxLines: 3,
        maxChars: 50,
      },
    );

    expect(result).toBeNull();
  });
});

describe("createOutputFilter", () => {
  it("uses command registry and limits", () => {
    const filter = createOutputFilter({
      enabled: true,
      commands: ["cargo test"],
      maxLines: 1,
      maxChars: 100,
    });

    expect(filter.id).toBe("commands");
    expect(filter.enabled).toBe(true);
    expect(filter.matches("cargo test -- --watch")).toBe(true);
    expect(filter.apply("a\nb", "cargo test")).toBe("b");
  });
});
