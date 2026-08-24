// E2E: terminal-browser Herdr panel lifecycle — real herdr + terminal-browser CLIs.
// Flow: resolve strategy → open (split right) → verify pane created → close → verify pane gone.
// Run from the extension dir: bun scripts/e2e-panel-lifecycle.ts
// (or from the repo root: bun extensions/plannotator-auto/scripts/e2e-panel-lifecycle.ts)
// Requires a Herdr environment: HERDR_ENV=1 + HERDR_PANE_ID. This briefly
// splits a real pane to the right of the current pane and closes it again.
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearLastOpened,
  openUrlInHerdrTerminalBrowser,
  resolveHerdrPanelStrategy,
  tryCloseTerminalBrowserTab,
} from "../terminal-browser.ts";

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  — ${extra}` : ""}`);
  if (!ok) failures += 1;
};

const panes = (): string[] => {
  const out = execSync("herdr pane list", { encoding: "utf8" });
  return JSON.parse(out).result.panes.map(
    (p: { pane_id: string }) => p.pane_id,
  );
};
const launcherPaneIsRightmost = (): boolean => {
  // Probe the LAUNCHER pane explicitly (HERDR_PANE_ID), mirroring
  // hasHerdrRightPane. edges.right === true means the probed pane is
  // rightmost (no right neighbor); === false means a pane exists to its
  // right. An unnamed probe follows focus, which moves to the new pane after
  // --split right and would measure the wrong pane.
  const pane = process.env.HERDR_PANE_ID;
  const out = execSync(`herdr pane edges${pane ? ` --pane ${pane}` : ""}`, {
    encoding: "utf8",
  });
  return JSON.parse(out).result.edges.right === true;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const tmpHtml = path.join(os.tmpdir(), `e2e-panel-${Date.now()}.html`);
fs.writeFileSync(tmpHtml, "<h1>herdr panel e2e</h1>");

const ctx = {
  // cwd only feeds the session key for lastOpenedByKey tracking; any
  // directory works for the e2e.
  cwd: process.cwd(),
  sessionManager: {
    getSessionFile: () => path.join(os.tmpdir(), "e2e-session.json"),
  },
};

try {
  clearLastOpened();
  const before = panes().sort();

  check(
    "launcher pane is rightmost before open (no right pane yet)",
    launcherPaneIsRightmost() === true,
  );

  const strategy = await resolveHerdrPanelStrategy();
  check(
    "strategy === split (no right pane exists)",
    strategy === "split",
    `got ${strategy}`,
  );
  if (strategy !== "split") {
    // Never process.exit here: it bypasses the finally block (tmp file + any
    // tracked pane state cleanup). Fall through with failures set instead.
    console.log("abort: would not split — refusing to run new-tab path in e2e");
    failures += 1;
  } else {
    await openUrlInHerdrTerminalBrowser(`file://${tmpHtml}`, ctx);
    await sleep(1500); // let terminal-browser boot + herdr register the pane

    const afterOpen = panes().sort();
    const created = afterOpen.filter((p) => !before.includes(p));
    check(
      "a new pane was created on the right",
      created.length >= 1,
      `new: ${created.join(",") ?? "none"}`,
    );
    check(
      "launcher pane has a right neighbor after split",
      launcherPaneIsRightmost() === false,
    );

    if (created.length >= 1) {
      await tryCloseTerminalBrowserTab(ctx);
      await sleep(1200);

      const afterClose = panes().sort();
      const leftover = created.filter((p) => afterClose.includes(p));
      check(
        "created pane was closed by tryCloseTerminalBrowserTab",
        leftover.length === 0,
        `leftover: ${leftover.join(",") || "none"}`,
      );
      check(
        "launcher pane is rightmost again after close",
        launcherPaneIsRightmost() === true,
      );
    } else {
      console.log("WARN: no pane created — skipping close phase");
      failures += 1;
    }
  }
} catch (error) {
  console.error("E2E ERROR:", error);
  failures += 1;
} finally {
  fs.rmSync(tmpHtml, { force: true });
}

console.log(
  failures === 0 ? "\nE2E: ALL GREEN" : `\nE2E: ${failures} FAILURE(S)`,
);
process.exit(failures === 0 ? 0 : 1);
