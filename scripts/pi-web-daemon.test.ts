import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decideStart,
  main,
  parseArgs,
  parseStatus,
  startPlan,
} from "./pi-web-daemon.mjs";

const okOptions = (argv: string[], env: Record<string, string> = {}) => {
  const parsed = parseArgs(argv, env, "/tmp/project");
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.options;
};

const fakeIo = () => ({ log: vi.fn(), error: vi.fn() });

describe("parseArgs", () => {
  it("defaults to start on the default port with the browser opened", () => {
    const options = okOptions([], { PI_WEB_CWD: "/tmp/project" });

    expect(options.command).toBe("start");
    expect(options.port).toBe(30141);
    expect(options.bin).toBe("pi-web");
    expect(options.logPath).toBe("/tmp/pi-web.log");
    expect(options.cwd).toBe("/tmp/project");
    expect(options.force).toBe(false);
    expect(options.open).toBe(true);
  });

  it("takes cwd from the injected argument, not from the process", () => {
    const options = okOptions([]);

    expect(options.cwd).toBe("/tmp/project");
  });

  it("reads the port from PORT and lets --port win", () => {
    expect(okOptions([], { PORT: "8080" }).port).toBe(8080);
    expect(okOptions(["--port", "9090"], { PORT: "8080" }).port).toBe(9090);
    expect(okOptions(["-p", "7070"]).port).toBe(7070);
  });

  it("supports restart, --force and --no-open", () => {
    expect(okOptions(["restart"]).command).toBe("restart");
    expect(okOptions(["--force"]).force).toBe(true);
    expect(okOptions(["--no-open"]).open).toBe(false);
  });

  it("overrides cwd, bin and log", () => {
    const options = okOptions([
      "--cwd",
      "/srv/pi",
      "--bin",
      "/usr/local/bin/pi-web",
      "--log",
      "/tmp/other.log",
    ]);

    expect(options.cwd).toBe("/srv/pi");
    expect(options.bin).toBe("/usr/local/bin/pi-web");
    expect(options.logPath).toBe("/tmp/other.log");
  });

  it("rejects unknown commands, unknown options and missing values", () => {
    expect(parseArgs(["deploy"], {}, "/tmp/project").ok).toBe(false);
    expect(parseArgs(["--nope"], {}, "/tmp/project").ok).toBe(false);
    expect(parseArgs(["--port"], {}, "/tmp/project").ok).toBe(false);
    expect(parseArgs(["--port", "abc"], {}, "/tmp/project").ok).toBe(false);
    expect(parseArgs(["--log"], {}, "/tmp/project").ok).toBe(false);
  });

  it("treats the help command like --help", () => {
    expect(okOptions(["help"]).help).toBe(true);
    expect(okOptions(["--help"]).help).toBe(true);
  });
});

describe("main (IO shell, io seam)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits 2 and prints usage on a bad flag without spawning anything", async () => {
    const io = fakeIo();

    expect(await main(["--port"], {}, io)).toBe(2);
    expect(io.error).toHaveBeenCalledWith(
      expect.stringContaining("pi-web-daemon: --port needs a port number"),
    );
    expect(io.log).not.toHaveBeenCalled();
  });

  it("exits 0 and prints usage for --help", async () => {
    const io = fakeIo();

    expect(await main(["help"], {}, io)).toBe(0);
    expect(io.log).toHaveBeenCalledWith(
      expect.stringContaining("Start Pi Web detached"),
    );
    expect(io.error).not.toHaveBeenCalled();
  });
});

describe("parseStatus", () => {
  it("returns nothing when no server is running", () => {
    expect(parseStatus("No pi-web server is running.\n")).toEqual([]);
  });

  it("maps running server lines to plain records", () => {
    const stdout = [
      "Running pi-web servers:",
      "  http://127.0.0.1:30141  pid 97396  v0.12.1  started 2026-10-15T04:00:57.719Z",
      "  http://127.0.0.1:8080  pid 610  v0.12.1  started 2026-10-15T04:01:00.000Z",
      "",
    ].join("\n");

    expect(parseStatus(stdout)).toEqual([
      {
        url: "http://127.0.0.1:30141",
        pid: 97396,
        version: "0.12.1",
        startedAt: "2026-10-15T04:00:57.719Z",
        port: 30141,
      },
      {
        url: "http://127.0.0.1:8080",
        pid: 610,
        version: "0.12.1",
        startedAt: "2026-10-15T04:01:00.000Z",
        port: 8080,
      },
    ]);
  });
});

describe("decideStart", () => {
  const running = [
    {
      url: "http://127.0.0.1:30141",
      pid: 97396,
      version: "0.12.1",
      startedAt: "2026-10-15T04:00:57.719Z",
      port: 30141,
    },
  ];

  it("starts when nothing is running", () => {
    expect(decideStart({ running: [], port: 30141, force: false }).action).toBe(
      "start",
    );
  });

  it("starts when another port is in use", () => {
    expect(decideStart({ running, port: 8080, force: false }).action).toBe(
      "start",
    );
  });

  it("reports the existing instance when the port matches", () => {
    const decision = decideStart({ running, port: 30141, force: false });

    expect(decision.action).toBe("already-running");
    expect(decision.reason).toContain("pid 97396");
  });

  it("stops the existing instance first when forced", () => {
    expect(decideStart({ running, port: 30141, force: true }).action).toBe(
      "stop-then-start",
    );
  });
});

describe("startPlan", () => {
  const base = {
    bin: "pi-web",
    port: 30141,
    cwd: "/srv/pi",
    logPath: "/tmp/pi-web.log",
    open: true,
  };

  it("keeps the browser open by default", () => {
    const plan = startPlan(base);

    expect(plan.args).toEqual(["--port", "30141"]);
    expect(plan.url).toBe("http://127.0.0.1:30141/");
    expect(plan.cwd).toBe("/srv/pi");
    expect(plan.logPath).toBe("/tmp/pi-web.log");
  });

  it("adds --no-open when the browser is disabled", () => {
    expect(startPlan({ ...base, open: false }).args).toEqual([
      "--port",
      "30141",
      "--no-open",
    ]);
  });
});
