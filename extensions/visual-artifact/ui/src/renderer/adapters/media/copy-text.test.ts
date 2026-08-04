import { describe, expect, it, vi } from "vitest";
import { type CopyIo, copyText } from "./copy-text.ts";

function makeIo(overrides: Partial<CopyIo> = {}): {
  io: CopyIo;
  clipboardWrite: ReturnType<typeof vi.fn>;
  legacyCopy: ReturnType<typeof vi.fn>;
} {
  const clipboardWrite = vi.fn(async () => true);
  const legacyCopy = vi.fn(() => true);
  return {
    io: { clipboardWrite, legacyCopy, ...overrides },
    clipboardWrite,
    legacyCopy,
  };
}

describe("copyText", () => {
  it("returns copied when the primary clipboard write succeeds", async () => {
    const { io, clipboardWrite, legacyCopy } = makeIo();

    await expect(copyText("flowchart LR\nA-->B", io)).resolves.toBe("copied");

    expect(clipboardWrite).toHaveBeenCalledWith("flowchart LR\nA-->B");
    expect(legacyCopy).not.toHaveBeenCalled();
  });

  it("falls back to legacyCopy when clipboardWrite returns false", async () => {
    const { io, legacyCopy } = makeIo({
      clipboardWrite: vi.fn(async () => false),
    });

    await expect(copyText("text", io)).resolves.toBe("copied");

    expect(legacyCopy).toHaveBeenCalledWith("text");
  });

  it("falls back to legacyCopy when clipboardWrite rejects", async () => {
    const { io, legacyCopy } = makeIo({
      clipboardWrite: vi.fn(async () => {
        throw new Error("NotAllowedError");
      }),
    });

    await expect(copyText("text", io)).resolves.toBe("copied");

    expect(legacyCopy).toHaveBeenCalledWith("text");
  });

  it("returns failed when both strategies fail", async () => {
    const { io } = makeIo({
      clipboardWrite: vi.fn(async () => false),
      legacyCopy: vi.fn(() => false),
    });

    await expect(copyText("text", io)).resolves.toBe("failed");
  });

  it("returns failed when legacyCopy throws", async () => {
    const { io } = makeIo({
      clipboardWrite: vi.fn(async () => false),
      legacyCopy: vi.fn(() => {
        throw new Error("boom");
      }),
    });

    await expect(copyText("text", io)).resolves.toBe("failed");
  });

  it("returns failed for empty text without touching either strategy", async () => {
    const { io, clipboardWrite, legacyCopy } = makeIo();

    await expect(copyText("", io)).resolves.toBe("failed");
    await expect(copyText("   ", io)).resolves.toBe("failed");

    expect(clipboardWrite).not.toHaveBeenCalled();
    expect(legacyCopy).not.toHaveBeenCalled();
  });
});
