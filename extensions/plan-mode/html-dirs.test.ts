import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("../shared/settings.js");
});

const mockHtmlDirsSetting = (htmlDirs: string[] | null | undefined) => {
  vi.resetModules();
  vi.doMock("../shared/settings.js", async (importOriginal) => {
    const original =
      await importOriginal<typeof import("../shared/settings.js")>();
    return {
      ...original,
      loadSettings: () => ({
        global: {},
        project: {},
        merged: {
          ...(htmlDirs === undefined ? {} : { plannotatorAuto: { htmlDirs } }),
        },
      }),
    };
  });
  return import("./html-dirs.js");
};

describe("resolveHtmlArtifactDirs", () => {
  it("falls back to the default .pi/html/<repo> dir when no config is set", async () => {
    const { resolveHtmlArtifactDirs } = await mockHtmlDirsSetting(undefined);
    expect(resolveHtmlArtifactDirs("/repo")).toContain("/repo/.pi/html/repo");
  });

  it("uses configured plannotatorAuto.htmlDirs when present", async () => {
    const { resolveHtmlArtifactDirs } = await mockHtmlDirsSetting([
      ".pi/html/custom",
    ]);
    expect(resolveHtmlArtifactDirs("/repo")).toContain("/repo/.pi/html/custom");
    expect(resolveHtmlArtifactDirs("/repo")).not.toContain(
      "/repo/.pi/html/repo",
    );
  });

  it("disables HTML review when htmlDirs is null (matches plannotator-auto)", async () => {
    const { resolveHtmlArtifactDirs } = await mockHtmlDirsSetting(null);
    expect(resolveHtmlArtifactDirs("/repo")).toEqual([]);
  });

  it("disables HTML review when htmlDirs is an empty array", async () => {
    const { resolveHtmlArtifactDirs } = await mockHtmlDirsSetting([]);
    expect(resolveHtmlArtifactDirs("/repo")).toEqual([]);
  });

  it("disables HTML review when htmlDirs entries are all blank", async () => {
    const { resolveHtmlArtifactDirs } = await mockHtmlDirsSetting(["  "]);
    expect(resolveHtmlArtifactDirs("/repo")).toEqual([]);
  });
});

describe("isHtmlArtifactPathIn", () => {
  it("matches dated HTML files under the given dirs", async () => {
    const { isHtmlArtifactPathIn, resolveHtmlArtifactDirs } =
      await mockHtmlDirsSetting(undefined);
    expect(
      isHtmlArtifactPathIn(
        resolveHtmlArtifactDirs("/repo"),
        "/repo/.pi/html/repo/2026-08-05-proto.html",
      ),
    ).toBe(true);
  });

  it("rejects non-dated filenames", async () => {
    const { isHtmlArtifactPathIn, resolveHtmlArtifactDirs } =
      await mockHtmlDirsSetting(undefined);
    expect(
      isHtmlArtifactPathIn(
        resolveHtmlArtifactDirs("/repo"),
        "/repo/.pi/html/repo/proto.html",
      ),
    ).toBe(false);
  });

  it("rejects non-HTML files", async () => {
    const { isHtmlArtifactPathIn, resolveHtmlArtifactDirs } =
      await mockHtmlDirsSetting(undefined);
    expect(
      isHtmlArtifactPathIn(
        resolveHtmlArtifactDirs("/repo"),
        "/repo/.pi/html/repo/2026-08-05-proto.md",
      ),
    ).toBe(false);
  });

  it("rejects files outside the html dirs", async () => {
    const { isHtmlArtifactPathIn, resolveHtmlArtifactDirs } =
      await mockHtmlDirsSetting(undefined);
    expect(
      isHtmlArtifactPathIn(
        resolveHtmlArtifactDirs("/repo"),
        "/repo/.pi/plans/repo/plan/2026-08-05-x.html",
      ),
    ).toBe(false);
  });

  it("rejects everything when HTML review is disabled (empty dirs)", async () => {
    const { isHtmlArtifactPathIn, resolveHtmlArtifactDirs } =
      await mockHtmlDirsSetting(null);
    expect(
      isHtmlArtifactPathIn(
        resolveHtmlArtifactDirs("/repo"),
        "/repo/.pi/html/repo/2026-08-05-proto.html",
      ),
    ).toBe(false);
  });
});
