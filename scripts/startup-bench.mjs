#!/usr/bin/env node
/**
 * pi startup benchmark. Reproduces the numbers in
 * .pi/plans/pi-kit/plan/2026-10-23-pi-startup-latency.md.
 *
 *   node scripts/startup-bench.mjs            # 9 runs, per-extension medians
 *   node scripts/startup-bench.mjs stats 9
 *   node scripts/startup-bench.mjs ab 8       # interleaved A/B of the dedupe switch
 *   node scripts/startup-bench.mjs profile    # CPU profile attribution
 *
 * Uses pi's built-in PI_TIMING instrumentation and `--mode rpc`, which exits on
 * stdin EOF and makes no model call, so a run costs one startup and no network.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = path.join(KIT, ".pi/extensions");
const DUPES = ["auto-trust-work", "cc-switch", "plugin-toggle"];
const HOLD = path.join(KIT, ".pi/.startup-bench-hold");

function runPi(args = ["--mode", "rpc"], env = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("pi", args, {
      cwd: KIT,
      env: { ...process.env, PI_TIMING: "1", ...env },
      // RPC mode reads JSON-RPC from stdin and exits on EOF; a pipe never closes.
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const kill = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", () => {
      clearTimeout(kill);
      resolve({ wall: Date.now() - started, out });
    });
  });
}

function parse(out) {
  const r = { main: null, ext: null, modules: 0, errors: [] };
  let ns = null;
  for (const line of out.split("\n")) {
    const m = line.match(/Startup Timings: (\w+)/);
    if (m) {
      ns = m[1];
      continue;
    }
    if (line.includes("module import:")) r.modules++;
    if (line.includes("Failed to load extension")) r.errors.push(line.trim());
    const t = line.match(/^\s+TOTAL: (\d+)ms/);
    if (!t) continue;
    if (ns === "main") r.main = Number(t[1]);
    if (ns === "extensions") r.ext = Number(t[1]);
  }
  return r;
}

const loadAverage = () =>
  loadavg()
    .slice(0, 1)
    .map((n) => n.toFixed(2))
    .join(" ");

const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const spread = (xs) => `${med(xs)}ms [${Math.min(...xs)}-${Math.max(...xs)}]`;

export async function stats(runs = 9) {
  const walls = [];
  const mains = [];
  const exts = [];
  const per = new Map();
  let modules = 0;
  const errors = [];
  for (let i = 0; i < runs; i++) {
    const { wall, out } = await runPi();
    const r = parse(out);
    walls.push(wall);
    if (r.main != null) mains.push(r.main);
    if (r.ext != null) exts.push(r.ext);
    modules = r.modules;
    errors.push(...r.errors);
    let ns = null;
    for (const line of out.split("\n")) {
      const m = line.match(/Startup Timings: (\w+)/);
      if (m) {
        ns = m[1];
        continue;
      }
      const t = line.match(/^\s+(.+?): (\d+)ms\s*$/);
      if (!t || ns !== "extensions" || t[1] === "TOTAL") continue;
      per.set(t[1], [...(per.get(t[1]) ?? []), Number(t[2])]);
    }
  }
  const rows = [...per]
    .map(([k, v]) => ({
      k: k
        .replace(`${path.join(KIT, ".pi/extensions")}/`, "P/")
        .replace("/Users/ming.chen/.pi/agent/extensions/", "G/"),
      med: med(v),
    }))
    .sort((a, b) => b.med - a.med);
  console.log(`runs=${runs} load=${loadAverage()}`);
  console.log(`wall        ${spread(walls)}`);
  console.log(`main TOTAL  ${spread(mains)}`);
  console.log(`exts TOTAL  ${spread(exts)}`);
  console.log(`modules     ${modules}`);
  console.log(`load errors ${errors.length}`);
  console.log("\ntop entries by median:");
  for (const r of rows.slice(0, 15)) {
    console.log(`  ${String(r.med).padStart(4)}ms  ${r.k}`);
  }
}

function setDedupe(on) {
  fs.mkdirSync(HOLD, { recursive: true });
  for (const name of DUPES) {
    const live = path.join(EXT_DIR, name);
    const held = path.join(HOLD, name);
    const liveExists = exists(live);
    const heldExists = exists(held);
    if (!on && liveExists) fs.renameSync(live, held);
    if (on && heldExists && !liveExists) fs.renameSync(held, live);
  }
}
const exists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

export async function ab(pairs = 8) {
  const A = { wall: [], main: [], ext: [], modules: 0 };
  const B = { wall: [], main: [], ext: [], modules: 0 };
  for (let i = 0; i < pairs; i++) {
    for (const [dedupe, acc] of [
      [false, A],
      [true, B],
    ]) {
      setDedupe(dedupe);
      const { wall, out } = await runPi();
      const r = parse(out);
      acc.wall.push(wall);
      if (r.main != null) acc.main.push(r.main);
      if (r.ext != null) acc.ext.push(r.ext);
      acc.modules = r.modules;
    }
  }
  setDedupe(true);
  const line = (label, acc) =>
    `${label} ext ${spread(acc.ext)}  main ${med(acc.main)}ms  wall ${med(acc.wall)}ms  modules ${acc.modules}`;
  console.log(`interleaved A/B, ${pairs} pairs`);
  console.log(line("A dupes ", A));
  console.log(line("B dedup ", B));
  console.log(
    `delta ext ${med(B.ext) - med(A.ext)}ms  main ${med(B.main) - med(A.main)}ms  wall ${med(B.wall) - med(A.wall)}ms`,
  );
}

async function profile() {
  const dir = fs.mkdtempSync(
    path.join(process.env.TMPDIR ?? "/tmp", "pi-prof-"),
  );
  const bin = path.join(
    process.env.PI_MANAGED_INSTALL_ROOT ?? "/Users/ming.chen/.pi/agent/install",
    "releases/1.4.0/node_modules/.bin/pi",
  );
  await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--cpu-prof", `--cpu-prof-dir=${dir}`, bin, "--mode", "rpc"],
      { cwd: KIT, stdio: ["ignore", "ignore", "ignore"] },
    );
    child.on("close", resolve);
  });
  const file = path.join(dir, fs.readdirSync(dir)[0]);
  const p = JSON.parse(fs.readFileSync(file, "utf8"));
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of p.nodes)
    for (const c of n.children ?? []) parent.set(c, n.id);
  const self = new Map();
  for (let i = 0; i < p.samples.length; i++) {
    self.set(
      p.samples[i],
      (self.get(p.samples[i]) ?? 0) + (p.timeDeltas[i] ?? 0),
    );
  }
  const isNodeInternal = (u) =>
    u.startsWith("node:") || u === "" || u === "native";
  const label = (n) =>
    `${n.callFrame.functionName || "(anon)"} @ ${(n.callFrame.url || "")
      .replace("file://", "")
      .replace(/^.*node_modules\//, "~nm/")
      .replace(`${KIT}/`, "~/kit/")}:${n.callFrame.lineNumber}`;
  const bucket = new Map();
  for (const [id, us] of self) {
    let cur = byId.get(id);
    while (cur && isNodeInternal(cur.callFrame.url)) {
      const pid = parent.get(cur.id);
      cur = pid ? byId.get(pid) : undefined;
    }
    const key = cur ? label(cur) : "(node internal root)";
    bucket.set(key, (bucket.get(key) ?? 0) + us / 1000);
  }
  console.log(`profile ${file}`);
  console.log("self time by nearest app caller (top 15):");
  for (const [k, v] of [...bucket].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${v.toFixed(0).padStart(5)}ms  ${k}`);
  }
}

const cmd = process.argv[2] ?? "stats";
const arg = Number(process.argv[3] ?? 0) || undefined;
if (cmd === "ab") await ab(arg ?? 8);
else if (cmd === "profile") await profile();
else await stats(arg ?? 9);
