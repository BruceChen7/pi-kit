import { describe, expect, it } from "vitest";
import {
  buildInstallArgs,
  resolveNpmRegistry,
  resolvePiBinary,
  updatePeerDependencies,
} from "./update-pi-coding-agent.mjs";

const createPiPeerDependencies = (version) => ({
  "@earendil-works/pi-ai": `^${version}`,
  "@earendil-works/pi-coding-agent": `^${version}`,
  "@earendil-works/pi-tui": `^${version}`,
});

describe("updatePeerDependencies", () => {
  it("updates pi-ai, pi-coding-agent, and pi-tui peer dependencies to the latest range", () => {
    const packageJson = {
      name: "pi-kit",
      peerDependencies: createPiPeerDependencies("0.63.1"),
    };

    const result = updatePeerDependencies(packageJson, "0.67.3");

    expect(result.peerDependencies).toEqual(createPiPeerDependencies("0.67.3"));
  });

  it("preserves unrelated package.json fields", () => {
    const packageJson = {
      name: "pi-kit",
      version: "0.1.0",
      scripts: {
        test: "vitest run",
      },
      peerDependencies: createPiPeerDependencies("0.63.1"),
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
        ...createPiPeerDependencies("0.63.1"),
        react: "^19.0.0",
      },
    };

    const result = updatePeerDependencies(packageJson, "0.67.3");

    expect(result.peerDependencies).toEqual({
      ...createPiPeerDependencies("0.67.3"),
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

describe("buildInstallArgs", () => {
  it("passes the public registry as a CLI argument", () => {
    expect(buildInstallArgs("1.3.0", {})).toEqual([
      "install",
      "@earendil-works/pi-ai@^1.3.0",
      "@earendil-works/pi-coding-agent@^1.3.0",
      "@earendil-works/pi-tui@^1.3.0",
      "--save-peer",
      "--registry=https://registry.npmjs.org/",
    ]);
  });

  it("allows an explicit registry override", () => {
    const env = { PI_NPM_REGISTRY: "https://npm.example.test/" };

    expect(resolveNpmRegistry(env)).toBe("https://npm.example.test/");
    expect(buildInstallArgs("1.3.0", env).at(-1)).toBe(
      "--registry=https://npm.example.test/",
    );
  });
});
