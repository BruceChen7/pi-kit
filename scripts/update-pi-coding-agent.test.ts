import { describe, expect, it } from "vitest";
import {
  resolvePiBinary,
  updatePeerDependencies,
} from "./update-pi-coding-agent.mjs";

describe("updatePeerDependencies", () => {
  it("updates both pi-coding-agent and pi-tui peer dependencies to the latest range", () => {
    const packageJson = {
      name: "pi-kit",
      peerDependencies: {
        "@earendil-works/pi-coding-agent": "^0.63.1",
        "@earendil-works/pi-tui": "^0.63.1",
      },
    };

    const result = updatePeerDependencies(packageJson, "0.67.3");

    expect(result.peerDependencies).toEqual({
      "@earendil-works/pi-coding-agent": "^0.67.3",
      "@earendil-works/pi-tui": "^0.67.3",
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
        "@earendil-works/pi-coding-agent": "^0.63.1",
        "@earendil-works/pi-tui": "^0.63.1",
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
        "@earendil-works/pi-coding-agent": "^0.63.1",
        "@earendil-works/pi-tui": "^0.63.1",
        react: "^19.0.0",
      },
    };

    const result = updatePeerDependencies(packageJson, "0.67.3");

    expect(result.peerDependencies).toEqual({
      "@earendil-works/pi-coding-agent": "^0.67.3",
      "@earendil-works/pi-tui": "^0.67.3",
      react: "^19.0.0",
    });
  });
});

describe("resolvePiBinary", () => {
  it("prefers the explicit PI_BIN override", () => {
    expect(
      resolvePiBinary({
        PI_BIN: "/custom/bin/pi",
      }),
    ).toBe("/custom/bin/pi");
  });

  it("falls back to the default global pi path", () => {
    expect(resolvePiBinary({})).toBe("/opt/homebrew/bin/pi");
  });
});
