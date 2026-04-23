import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIG,
  getRemoteApprovalSettings,
  mergeRemoteApprovalSettings,
  normalizeRemoteApprovalConfig,
} from "./config.ts";

describe("remote-approval config", () => {
  it("uses defaults when settings are missing", () => {
    expect(normalizeRemoteApprovalConfig(undefined)).toEqual(DEFAULT_CONFIG);
  });

  it("keeps credentials global-only while allowing project behavior overrides", () => {
    const merged = mergeRemoteApprovalSettings(
      {
        enabled: true,
        channelType: "telegram",
        botToken: "global-token",
        chatId: "1234",
        strictRemote: false,
        interceptTools: ["bash", "write", "edit"],
        idleEnabled: true,
        continueEnabled: true,
      },
      {
        botToken: "project-token-ignored",
        chatId: "9999",
        strictRemote: true,
        extraInterceptTools: ["deploy"],
        contextTurns: 5,
      },
    );

    expect(merged).toMatchObject({
      botToken: "global-token",
      chatId: "1234",
      strictRemote: true,
      extraInterceptTools: ["deploy"],
      contextTurns: 5,
    });
  });

  it("extracts only remoteApproval record settings", () => {
    expect(
      getRemoteApprovalSettings({
        remoteApproval: { enabled: false },
        other: { enabled: true },
      }),
    ).toEqual({ enabled: false });

    expect(getRemoteApprovalSettings({ remoteApproval: null })).toEqual({});
  });
});
