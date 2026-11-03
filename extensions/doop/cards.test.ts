import { describe, expect, it, vi } from "vitest";
import type { AuthRecord } from "./auth.js";
import {
  finishJob,
  PREFERENCE_MODEL,
  parseJob,
  pollJob,
  setCardsEnabled,
} from "./cards.js";
import type { DoopConfig } from "./config.js";

const config: DoopConfig = {
  baseUrl: "http://127.0.0.1:4300",
  agentKey: "dpk_test",
  agentName: "pi",
  canvasId: "U43rjP-JxT",
  watch: false,
  cards: true,
};

const auth: AuthRecord = {
  email: "rich@example.com",
  cookie: "better-auth.session_token=abc",
  obtainedAt: 1,
};

function jsonStub(status: number, body: unknown) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

describe("parseJob", () => {
  it("reads a job the server handed out", () => {
    expect(
      parseJob({
        id: "job-1",
        token: "tok",
        prompt: "Sketch a login screen",
        system: "you are a designer",
        maxTurns: 12,
      }),
    ).toEqual({
      id: "job-1",
      token: "tok",
      prompt: "Sketch a login screen",
      system: "you are a designer",
      maxTurns: 12,
    });
  });

  it("refuses a job without an id, token or prompt", () => {
    expect(parseJob({ token: "t", prompt: "p" })).toBeUndefined();
    expect(parseJob({ id: "1", prompt: "p" })).toBeUndefined();
    expect(parseJob({ id: "1", token: "t" })).toBeUndefined();
    expect(parseJob(null)).toBeUndefined();
  });

  it("defaults the system prompt and turn budget", () => {
    const job = parseJob({ id: "1", token: "t", prompt: "p" });
    expect(job?.system).toBe("");
    expect(job?.maxTurns).toBe(0);
  });
});

describe("setCardsEnabled", () => {
  it("puts the preference with the session cookie", async () => {
    const fetchImpl = jsonStub(200, { enabled: true });
    const result = await setCardsEnabled(
      config,
      auth,
      true,
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: true, value: { enabled: true } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://127.0.0.1:4300/api/local-agent");
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>).cookie).toBe(
      "better-auth.session_token=abc",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      enabled: true,
      model: PREFERENCE_MODEL,
    });
  });

  it("names /doop login when the session expired", async () => {
    const fetchImpl = jsonStub(401, { error: "no" });
    const result = await setCardsEnabled(
      config,
      auth,
      true,
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("/doop login");
  });
});

describe("pollJob", () => {
  it("returns the job and the enabled flag", async () => {
    const fetchImpl = jsonStub(200, {
      enabled: true,
      job: {
        id: "job-1",
        token: "tok",
        prompt: "design",
        system: "s",
        maxTurns: 3,
      },
    });
    const result = await pollJob(
      config,
      auth,
      "device-1",
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.job?.id).toBe("job-1");
    const [, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(String(init.body))).toEqual({ deviceId: "device-1" });
  });

  it("reports an idle poll without inventing a job", async () => {
    const fetchImpl = jsonStub(200, { enabled: true, job: null });
    const result = await pollJob(
      config,
      auth,
      "device-1",
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: true, value: { enabled: true } });
  });

  it("reports a turned-off preference", async () => {
    const fetchImpl = jsonStub(200, { enabled: false, job: null });
    const result = await pollJob(
      config,
      auth,
      "device-1",
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: true, value: { enabled: false } });
  });
});

describe("finishJob", () => {
  it("posts the result to the run id", async () => {
    const fetchImpl = jsonStub(200, { ok: true });
    const result = await finishJob(
      config,
      auth,
      "device-1",
      "job-1",
      { success: true, text: "done" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: true, value: { finished: true } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://127.0.0.1:4300/api/local-agent/finish/job-1");
    expect(JSON.parse(String(init.body))).toEqual({
      deviceId: "device-1",
      success: true,
      text: "done",
    });
  });

  it("treats 409 as already finished, not as an error", async () => {
    const fetchImpl = jsonStub(409, { ok: false });
    const result = await finishJob(
      config,
      auth,
      "device-1",
      "job-1",
      { success: true, text: "done" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: true, value: { finished: false } });
  });
});
