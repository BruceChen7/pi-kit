import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { bindCollector, createOutputCollector } from "./output-collector.ts";

describe("createOutputCollector", () => {
  it("accumulates chunks under the cap", () => {
    const c = createOutputCollector(10);
    expect(c.push("abc")).toBe(true);
    expect(c.push("defg")).toBe(true);
    expect(c.value).toBe("abcdefg");
    expect(c.truncated).toBe(false);
  });

  it("keeps a boundary chunk intact when it exactly fills the cap", () => {
    const c = createOutputCollector(5);
    expect(c.push("12345")).toBe(true);
    expect(c.value).toBe("12345");
    expect(c.truncated).toBe(false);
  });

  it("truncates at the cap and reports it", () => {
    const c = createOutputCollector(6);
    expect(c.push("abcdef")).toBe(true);
    expect(c.push("ghij")).toBe(false);
    expect(c.value).toBe("abcdef");
    expect(c.truncated).toBe(true);
    // further pushes are dropped
    expect(c.push("kl")).toBe(false);
    expect(c.value).toBe("abcdef");
  });

  it("truncates a single oversized chunk", () => {
    const c = createOutputCollector(4);
    expect(c.push("abcdefgh")).toBe(false);
    expect(c.value).toBe("abcd");
    expect(c.truncated).toBe(true);
  });

  it("handles a zero cap", () => {
    const c = createOutputCollector(0);
    expect(c.push("abc")).toBe(false);
    expect(c.value).toBe("");
    expect(c.truncated).toBe(true);
  });

  it("never throws on pathological input", () => {
    const c = createOutputCollector(100);
    const huge = "x".repeat(10_000_000);
    expect(c.push(huge)).toBe(false);
    expect(c.value.length).toBe(100);
    expect(c.truncated).toBe(true);
  });
});

describe("bindCollector", () => {
  it("collects chunks from a stream until the cap", () => {
    const stream = new PassThrough();
    const collector = createOutputCollector(6);
    const onTruncated = vi.fn();
    bindCollector(stream, collector, onTruncated);

    stream.write("abc");
    stream.write("def");

    expect(collector.value).toBe("abcdef");
    expect(collector.truncated).toBe(false);
    expect(onTruncated).not.toHaveBeenCalled();
  });

  it("invokes onTruncated once and stops collecting past the cap", () => {
    const stream = new PassThrough();
    const collector = createOutputCollector(4);
    const onTruncated = vi.fn();
    bindCollector(stream, collector, onTruncated);

    stream.write("abcdef");
    stream.write("gh");

    expect(collector.value).toBe("abcd");
    expect(collector.truncated).toBe(true);
    expect(onTruncated).toHaveBeenCalledOnce();
  });

  it("accepts both string and Buffer chunks", () => {
    const stream = new PassThrough();
    const collector = createOutputCollector(10);
    bindCollector(stream, collector, vi.fn());

    stream.write(Buffer.from("ab"));
    stream.write("cd");

    expect(collector.value).toBe("abcd");
    expect(collector.truncated).toBe(false);
  });

  it("treats a null stream as a no-op", () => {
    const collector = createOutputCollector(4);
    const onTruncated = vi.fn();
    expect(() => bindCollector(null, collector, onTruncated)).not.toThrow();
    expect(collector.truncated).toBe(false);
    expect(onTruncated).not.toHaveBeenCalled();
  });
});
