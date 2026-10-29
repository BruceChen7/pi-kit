import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  collectProviderRegistrations,
  createProviderForwardingExtension,
} from "./child-session-providers.js";

describe("collectProviderRegistrations", () => {
  const gateway = { baseUrl: "http://127.0.0.1:8231", apiKey: "PROXY_MANAGED" };

  it("keeps parent-registered providers the child model needs", () => {
    expect(
      collectProviderRegistrations({
        providers: ["cc-switch-gateway"],
        getConfig: (provider) =>
          provider === "cc-switch-gateway" ? gateway : undefined,
      }),
    ).toEqual([{ name: "cc-switch-gateway", config: gateway }]);
  });

  it("dedupes and skips providers the parent did not register", () => {
    const registrations = collectProviderRegistrations({
      providers: [
        "deepseek",
        "cc-switch-gateway",
        "cc-switch-gateway",
        undefined,
      ],
      getConfig: (provider) => (provider === "deepseek" ? undefined : gateway),
    });

    expect(registrations).toEqual([
      { name: "cc-switch-gateway", config: gateway },
    ]);
  });
});

describe("createProviderForwardingExtension", () => {
  const gatewayConfig = { apiKey: "PROXY_MANAGED" } as ProviderConfig;

  it("replays the parent registration into the child api", () => {
    const registerProvider = vi.fn();

    createProviderForwardingExtension([
      { name: "cc-switch-gateway", config: gatewayConfig },
    ])({ registerProvider } as never);

    expect(registerProvider).toHaveBeenCalledWith(
      "cc-switch-gateway",
      gatewayConfig,
    );
  });
});
