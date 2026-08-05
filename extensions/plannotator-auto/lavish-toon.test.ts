import { describe, expect, it } from "vitest";
import { decodeToon } from "./lavish-toon.ts";

// Fixtures below are verbatim outputs captured from the real `lavish-axi`
// CLI (v0.1.45) on macOS — the CLI serializes results with
// `@toon-format/toon`, not JSON.

// eslint-disable-next-line no-template-curly-in-string
const realOpenOutput = [
  "session:",
  "  file: /private/tmp/lavish-test/test.html",
  '  url: "http://127.0.0.1:4387/session/ddd909a7df9e37c2"',
  "  status: opened",
  'next_step: "Do not respond to the user just yet."',
  "",
].join("\n");

const realUserEndedOpenOutput = [
  "session:",
  "  file: /private/tmp/lavish-test/test.html",
  '  url: "http://127.0.0.1:4387/session/ddd909a7df9e37c2"',
  "  status: user-ended",
  'next_step: "The user explicitly ended this Lavish Editor session."',
  "",
].join("\n");

const realFeedbackOutput = [
  "session:",
  "  file: /private/tmp/lavish-test/test.html",
  "  status: feedback",
  'dom_snapshot: ""',
  "prompts[3]{uid,prompt,selector,tag,text}:",
  '  "1",使用hello,html > body > h1,h1,test',
  '  "",fix this,"",message,Freeform message',
  '  "","","",feedback,The heading should be bigger.',
  'next_step: "Apply the requested changes."',
  "",
].join("\n");

const realEndedOutput = [
  "session:",
  "  file: /private/tmp/lavish-test/test.html",
  "  status: ended",
  "  ended_by: agent",
  'next_step: "This Lavish Editor session has ended. Stop polling."',
  "",
].join("\n");

describe("decodeToon (real lavish-axi output)", () => {
  it("decodes a normal open result", () => {
    const parsed = decodeToon(realOpenOutput);
    expect(parsed).not.toBeNull();
    expect(parsed?.session).toEqual({
      file: "/private/tmp/lavish-test/test.html",
      url: "http://127.0.0.1:4387/session/ddd909a7df9e37c2",
      status: "opened",
    });
    expect(typeof parsed?.next_step).toBe("string");
  });

  it("decodes a user-ended open result", () => {
    const parsed = decodeToon(realUserEndedOpenOutput);
    expect(parsed?.session).toMatchObject({ status: "user-ended" });
  });

  it("decodes a feedback poll result with tabular prompts", () => {
    const parsed = decodeToon(realFeedbackOutput);
    expect(parsed?.session).toMatchObject({ status: "feedback" });
    expect(parsed?.dom_snapshot).toBe("");
    expect(parsed?.prompts).toEqual([
      {
        uid: "1",
        prompt: "使用hello",
        selector: "html > body > h1",
        tag: "h1",
        text: "test",
      },
      {
        uid: "",
        prompt: "fix this",
        selector: "",
        tag: "message",
        text: "Freeform message",
      },
      {
        uid: "",
        prompt: "",
        selector: "",
        tag: "feedback",
        text: "The heading should be bigger.",
      },
    ]);
    expect(typeof parsed?.next_step).toBe("string");
  });

  it("decodes an ended poll result", () => {
    const parsed = decodeToon(realEndedOutput);
    expect(parsed?.session).toMatchObject({
      status: "ended",
      ended_by: "agent",
    });
  });
});

describe("decodeToon edge cases", () => {
  it("handles empty arrays", () => {
    const parsed = decodeToon('prompts: []\nnext_step: "done"\n');
    expect(parsed?.prompts).toEqual([]);
    expect(parsed?.next_step).toBe("done");
  });

  it("handles quoted strings with commas inside tabular rows", () => {
    const parsed = decodeToon(
      [
        "session:",
        "  file: /repo/x.html",
        "  status: feedback",
        "prompts[2]{text,tag}:",
        '  "Please refine the layout, and add a header.",message',
        '  "Second one, with trailing comma.",feedback',
        "",
      ].join("\n"),
    );
    expect(parsed?.prompts).toEqual([
      { text: "Please refine the layout, and add a header.", tag: "message" },
      { text: "Second one, with trailing comma.", tag: "feedback" },
    ]);
  });

  it("handles list-item arrays", () => {
    const parsed = decodeToon(
      [
        "items[2]:",
        '  - text: "first"',
        '    tag: "a"',
        '  - text: "second"',
        "",
      ].join("\n"),
    );
    expect(parsed?.items).toEqual([
      { text: "first", tag: "a" },
      { text: "second" },
    ]);
  });

  it("returns null for empty input and does not crash on plain text", () => {
    expect(decodeToon("")).toBeNull();
    expect(decodeToon("   \n\n  ")).toBeNull();
    // A bare error message is not a session/prompts document, but the
    // decoder must not throw; callers fall back when `session` is missing.
    const bare = decodeToon("error: lavish-axi session not active");
    expect(bare).not.toBeNull();
    expect(bare?.session).toBeUndefined();
    expect(bare?.prompts).toBeUndefined();
  });

  it("handles booleans, numbers and null scalars", () => {
    const parsed = decodeToon(
      [
        "session:",
        "  status: feedback",
        "  session_ended: true",
        "  ended_by: user",
        "count: 3",
        "nothing: null",
        "",
      ].join("\n"),
    );
    expect(parsed?.session).toEqual({
      status: "feedback",
      session_ended: true,
      ended_by: "user",
    });
    expect(parsed?.count).toBe(3);
    expect(parsed?.nothing).toBeNull();
  });
});
