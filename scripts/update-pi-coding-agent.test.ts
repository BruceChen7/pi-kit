import { describe, expect, it } from "vitest";
import { updatePeerDependencies } from "./update-pi-coding-agent.mjs";

describe("updatePeerDependencies", () => {
  it("updates both pi-coding-agent and pi-tui peer dependencies to the latest range", () => {
    const packageJson = {
      name: "pi-kit",
      peerDependencies: {
        "@mariozechner/pi-coding-agent": "^0.63.1",
        "@mariozechner/pi-tui": "^0.63.1",
      },
    };

    const result = updatePeerDependencies(packageJson, "0.67.3");

    expect(result.peerDependencies).toEqual({
      "@mariozechner/pi-coding-agent": "^0.67.3",
      "@mariozechner/pi-tui": "^0.67.3",
    });
  });

  it("preserves unrelated package.json fields", () => {
    const packageJson = {
      name: "pi-kit",
      version: "0.1.0",
      scripts: {
        test: "vitest run",
      },
      peerDependencies: {
        "@mariozechner/pi-coding-agent": "^0.63.1",
        "@mariozechner/pi-tui": "^0.63.1",
      },
      custom: {
        enabled: true,
      },
    };

    const result = updatePeerDependencies(packageJson, "0.67.3");

    expect(result.name).toBe("pi-kit");
    expect(result.version).toBe("0.1.0");
    expect(result.scripts).toEqual({
      test: "vitest run",
    });
    expect(result.custom).toEqual({
      enabled: true,
    });
  });

  it("does not change other peer dependency entries", () => {
    const packageJson = {
      peerDependencies: {
        "@mariozechner/pi-coding-agent": "^0.63.1",
        "@mariozechner/pi-tui": "^0.63.1",
        react: "^19.0.0",
      },
    };

    const result = updatePeerDependencies(packageJson, "0.67.3");

    expect(result.peerDependencies).toEqual({
      "@mariozechner/pi-coding-agent": "^0.67.3",
      "@mariozechner/pi-tui": "^0.67.3",
      react: "^19.0.0",
    });
  });
});
