import { expect, test } from "vitest";

import { createError, createSuccess, JsonLineCodec } from "./protocol.js";

test("decodes complete newline-delimited JSON messages", () => {
  const codec = new JsonLineCodec();

  const first = codec.push(
    Buffer.from('{"id":"1","method":"ping"}\n{"id":"2"'),
  );
  const second = codec.push(Buffer.from(',"method":"pong"}\n'));

  expect(first).toEqual([{ id: "1", method: "ping" }]);
  expect(second).toEqual([{ id: "2", method: "pong" }]);
});

test("creates json-rpc style success and error envelopes", () => {
  expect(createSuccess("1", { ok: true })).toEqual({
    id: "1",
    result: { ok: true },
  });
  expect(createError("2", "boom")).toEqual({
    id: "2",
    error: { message: "boom" },
  });
});
