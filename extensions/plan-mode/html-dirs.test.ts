import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("../shared/settings.js");
});

describe("resolveHtmlArtifactDirs", () => {
  it("falls back to the default .pi/html/<repo> dir when no config is set", async () => {
    vi.resetModules();
    const { resolveHtmlArtifactDirs } = await import("./html-dirs.js");
    expect(resolveHtmlArtifactDirs("/repo")).toContain("/repo/.pi/html/repo");
  });

  it("uses configured plannotatorAuto.htmlDirs when present", async () => {
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
            plannotatorAuto: { htmlDirs: [".pi/html/custom"] },
          },
        }),
      };
    });
    const { resolveHtmlArtifactDirs } = await import("./html-dirs.js");
    expect(resolveHtmlArtifactDirs("/repo")).toContain("/repo/.pi/html/custom");
    expect(resolveHtmlArtifactDirs("/repo")).not.toContain(
      "/repo/.pi/html/repo",
    );
  });
});

describe("isHtmlArtifactPath", () => {
  it("matches dated HTML files under the default html dir", async () => {
    vi.resetModules();
    const { isHtmlArtifactPath } = await import("./html-dirs.js");
    expect(
      isHtmlArtifactPath("/repo", "/repo/.pi/html/repo/2026-08-05-proto.html"),
    ).toBe(true);
  });

  it("rejects non-dated filenames", async () => {
    vi.resetModules();
    const { isHtmlArtifactPath } = await import("./html-dirs.js");
    expect(isHtmlArtifactPath("/repo", "/repo/.pi/html/repo/proto.html")).toBe(
      false,
    );
  });

  it("rejects non-HTML files", async () => {
    vi.resetModules();
    const { isHtmlArtifactPath } = await import("./html-dirs.js");
    expect(
      isHtmlArtifactPath("/repo", "/repo/.pi/html/repo/2026-08-05-proto.md"),
    ).toBe(false);
  });

  it("rejects files outside the html dirs", async () => {
    vi.resetModules();
    const { isHtmlArtifactPath } = await import("./html-dirs.js");
    expect(
      isHtmlArtifactPath(
        "/repo",
        "/repo/.pi/plans/repo/plan/2026-08-05-x.html",
      ),
    ).toBe(false);
  });
});
