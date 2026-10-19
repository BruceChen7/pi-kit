#!/usr/bin/env node
/**
 * Mermaid engine differential probe — P0 of the pele migration plan
 * (.pi/plans/pi-kit/plan/2026-10-19-pele-replace-mermaid-dependency.md).
 *
 * Question it answers: would swapping the Node-side validation engine from
 * mermaid to pele change any verdict on the diagrams we actually have?
 *
 * It runs both engines over the repo's mermaid corpus — ```mermaid fences in
 * plan/spec documents plus mermaid nodes in visual-artifact specs — and
 * classifies each block into four buckets:
 *
 *   both-ok          agreement (most blocks)
 *   both-fail        agreement, diagram is broken either way
 *   mermaid-only-ok  pele rejects a diagram mermaid accepts  → BLOCKING RISK:
 *                    pele on the submission gate would block a valid plan
 *   pele-only-ok     pele accepts a diagram mermaid rejects → silent gap:
 *                    the gate would let through a diagram mermaid cannot draw
 *
 * Exit code is 1 when any mermaid-only-ok block exists, so the probe can be
 * used as a gate itself.
 *
 * Architecture: Functional Core, Imperative Shell.
 *   - collectMermaidFences / collectArtifactMermaidNodes / classifyDivergence /
 *     parseSamples / summarizeReport are the pure core (value in / value out).
 *   - loadEngines / main do the IO: read files, import engines, time calls,
 *     write the report.
 *
 * Usage:
 *   node scripts/mermaid-corpus-diff.mjs [--root <dir>]... [--out <file>]
 * Defaults: --root .pi/plans --root .pi/visual-artifact/artifacts
 *           --out .pi/plans/pi-kit/evidence/mermaid-corpus-diff.md
 */

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const DEFAULT_ROOTS = [".pi/plans", ".pi/visual-artifact/artifacts"];
const DEFAULT_OUT = ".pi/plans/pi-kit/evidence/mermaid-corpus-diff.md";
const SAMPLE_LIMIT = 12;

/* ------------------------------------------------------------------ */
/*  Pure core: corpus scanning                                         */
/* ------------------------------------------------------------------ */

const FENCE_OPEN_RE = /^\s*```+\s*mermaid\b\s*$/i;
const FENCE_CLOSE_RE = /^\s*```+\s*$/;

/**
 * Extract ```mermaid fenced blocks from markdown.
 * Unclosed fences close at end of document (reported like the product's
 * scanner does, so the corpus probe sees the same blocks the gate sees).
 *
 * @param {string} markdown
 * @returns {{ startLine: number, body: string }[]}
 */
export function collectMermaidFences(markdown) {
  const lines = markdown.split(/\r?\n/u);
  const blocks = [];
  let start = null;

  for (const [index, line] of lines.entries()) {
    if (start === null) {
      if (FENCE_OPEN_RE.test(line)) start = index + 1;
      continue;
    }
    if (FENCE_CLOSE_RE.test(line)) {
      blocks.push({
        startLine: start,
        body: lines.slice(start, index).join("\n"),
      });
      start = null;
    }
  }
  if (start !== null) {
    blocks.push({ startLine: start, body: lines.slice(start).join("\n") });
  }

  return blocks;
}

/**
 * Extract mermaid definitions from a visual-artifact spec JSON.
 * Nodes carry the source as `props.definition` or `props.code`.
 *
 * @param {string} specText
 * @returns {{ path: string, body: string }[]}
 */
export function collectArtifactMermaidNodes(specText) {
  let spec;
  try {
    spec = JSON.parse(specText);
  } catch {
    return [];
  }

  const found = [];
  const walk = (node, nodePath) => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => {
        walk(child, `${nodePath}[${index}]`);
      });
      return;
    }
    if (typeof node !== "object" || node === null) return;

    if (
      node.type === "mermaid" &&
      typeof node.props === "object" &&
      node.props !== null
    ) {
      const body = node.props.definition ?? node.props.code;
      if (typeof body === "string" && body.trim().length > 0) {
        found.push({ path: nodePath, body });
      }
    }
    for (const [key, value] of Object.entries(node)) {
      walk(value, `${nodePath}.${key}`);
    }
  };

  walk(spec, "$");
  return found;
}

/** Mermaid diagram type keyword of a block (frontmatter and comments skipped). */
export function detectDiagramType(body) {
  let inFrontmatter = false;
  for (const line of body.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("%%")) continue;
    if (trimmed === "---") {
      inFrontmatter = !inFrontmatter;
      continue;
    }
    if (inFrontmatter) continue;
    return trimmed.split(/\s+/u)[0];
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/*  Pure core: classification + reporting                              */
/* ------------------------------------------------------------------ */

/**
 * Classify one block's two engine outcomes.
 *
 * @param {{ ok: boolean }} mermaid
 * @param {{ ok: boolean }} pele
 * @returns {"both-ok" | "both-fail" | "mermaid-only-ok" | "pele-only-ok"}
 */
export function classifyDivergence(mermaid, pele) {
  if (mermaid.ok && pele.ok) return "both-ok";
  if (!mermaid.ok && !pele.ok) return "both-fail";
  return mermaid.ok ? "mermaid-only-ok" : "pele-only-ok";
}

/** Count blocks per divergence bucket. */
export function countDivergences(results) {
  const counts = {
    "both-ok": 0,
    "both-fail": 0,
    "mermaid-only-ok": 0,
    "pele-only-ok": 0,
  };
  for (const result of results) counts[result.kind] += 1;
  return counts;
}

/** Blocks worth showing in the report, cheapest-first (blocking bucket first). */
export function parseSamples(results, kind, limit = SAMPLE_LIMIT) {
  return results.filter((result) => result.kind === kind).slice(0, limit);
}

const firstLine = (text) =>
  String(text ?? "")
    .split(/\r?\n/u)
    .find((line) => line.trim().length > 0) ?? "";

const escapeCell = (text) => String(text).replaceAll("|", "\\|");

/**
 * Build the whole markdown report.
 *
 * @param {object} input
 * @param {Array<object>} input.results per-block outcomes
 * @param {{ mermaid: object, pele: object }} input.engines engine versions + timings
 * @param {string[]} input.sources scanned roots (for provenance)
 * @returns {string}
 */
export function summarizeReport({ results, engines, sources }) {
  const counts = countDivergences(results);
  const total = results.length;
  const blocking = counts["mermaid-only-ok"];
  const lines = [];

  lines.push("# Mermaid engine differential report (P0)");
  lines.push("");
  lines.push(
    `Generated by \`scripts/mermaid-corpus-diff.mjs\` on ${new Date().toISOString()}.`,
  );
  lines.push("");
  lines.push(
    `- Corpus: ${sources.map((source) => `\`${source}\``).join(", ")}`,
  );
  lines.push(
    `- Blocks: ${total} (${results.filter((r) => r.origin === "fence").length} markdown fences, ${results.filter((r) => r.origin === "artifact").length} artifact nodes)`,
  );
  lines.push(
    `- Engines: mermaid ${engines.mermaid.version}, pele ${engines.pele.version}`,
  );
  lines.push("");
  lines.push("## Verdict");
  lines.push("");
  lines.push(
    blocking === 0
      ? `No \`mermaid-only-ok\` block in this corpus: pele does not reject any diagram mermaid accepts here. ${counts["pele-only-ok"]} \`pele-only-ok\` block(s) remain to review before treating the engines as interchangeable.`
      : `**${blocking} \`mermaid-only-ok\` block(s)**: pele rejects diagrams mermaid accepts, so moving the submission gate to pele would block valid plans. Do not proceed with the gate swap until these are understood.`,
  );
  lines.push("");
  lines.push("## Outcomes");
  lines.push("");
  lines.push("| bucket | blocks | meaning |");
  lines.push("| --- | --- | --- |");
  lines.push(
    `| both-ok | ${counts["both-ok"]} | agreement: neither engine complains |`,
  );
  lines.push(
    `| both-fail | ${counts["both-fail"]} | agreement: diagram is broken in both |`,
  );
  lines.push(
    `| mermaid-only-ok | ${counts["mermaid-only-ok"]} | **blocking risk** for a pele gate |`,
  );
  lines.push(
    `| pele-only-ok | ${counts["pele-only-ok"]} | gap: pele accepts what mermaid rejects |`,
  );
  lines.push("");
  lines.push("## Engine cost");
  lines.push("");
  lines.push("| engine | import | parse total | parse mean |");
  lines.push("| --- | --- | --- | --- |");
  for (const [name, engine] of Object.entries(engines)) {
    const mean = engine.parseCount > 0 ? engine.parseMs / engine.parseCount : 0;
    lines.push(
      `| ${name} ${engine.version} | ${engine.importMs.toFixed(0)} ms | ${engine.parseMs.toFixed(0)} ms | ${mean.toFixed(1)} ms |`,
    );
  }
  lines.push("");
  lines.push("## Diagram types in the corpus");
  lines.push("");
  const types = new Map();
  for (const result of results) {
    const key = result.diagramType ?? "(unknown)";
    types.set(key, (types.get(key) ?? 0) + 1);
  }
  lines.push("| type | blocks |");
  lines.push("| --- | --- |");
  for (const [type, count] of [...types.entries()].sort(
    (a, b) => b[1] - a[1],
  )) {
    lines.push(`| ${escapeCell(type)} | ${count} |`);
  }
  lines.push("");

  for (const [kind, title] of [
    ["mermaid-only-ok", "pele rejects, mermaid accepts (blocking risk)"],
    ["pele-only-ok", "pele accepts, mermaid rejects (silent gap)"],
    ["both-fail", "both engines reject (probably genuinely broken)"],
  ]) {
    const samples = parseSamples(results, kind);
    if (samples.length === 0) continue;
    lines.push(`## Samples — ${title}`);
    lines.push("");
    lines.push("| block | type |");
    lines.push("| --- | --- |");
    for (const sample of samples) {
      lines.push(
        `| \`${escapeCell(sample.location)}\` | ${escapeCell(sample.diagramType ?? "?")} |`,
      );
    }
    lines.push("");
    for (const sample of samples) {
      lines.push(`### ${sample.location}`);
      lines.push("");
      if (!sample.mermaid.ok)
        lines.push(`- mermaid: ${escapeCell(firstLine(sample.mermaid.error))}`);
      if (!sample.pele.ok)
        lines.push(`- pele: ${escapeCell(firstLine(sample.pele.error))}`);
      if (!sample.mermaid.ok && !sample.pele.ok && sample.pele.renderError) {
        lines.push(
          `- pele render: ${escapeCell(firstLine(sample.pele.renderError))}`,
        );
      }
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
}

/* ------------------------------------------------------------------ */
/*  Shell: engines, filesystem, CLI                                    */
/* ------------------------------------------------------------------ */

const parseArgs = (argv) => {
  const roots = [];
  let out = DEFAULT_OUT;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--root") {
      index += 1;
      roots.push(argv[index]);
    } else if (flag === "--out") {
      index += 1;
      out = argv[index];
    }
  }
  return { roots: roots.length > 0 ? roots : DEFAULT_ROOTS, out };
};

const walkFiles = (dir, match) => {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".pi") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkFiles(full, match));
    else if (match(full)) found.push(full);
  }
  return found;
};

const relative = (file) => path.relative(REPO_ROOT, file);

const readVersion = (packageName) =>
  JSON.parse(
    readFileSync(
      path.join(REPO_ROOT, "node_modules", packageName, "package.json"),
      "utf8",
    ),
  ).version;

/** Load both engines, each with its own timing budget. */
async function loadEngines() {
  const mermaidStart = performance.now();
  const { parseHTML } = await import("linkedom");
  const dom = parseHTML("<!DOCTYPE html><html><body></body></html>");
  globalThis.window = dom.window;
  globalThis.document = dom.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  const mermaid = (await import("mermaid")).default;
  mermaid.initialize({ startOnLoad: false, securityLevel: "loose" });
  const mermaidImportMs = performance.now() - mermaidStart;

  const peleStart = performance.now();
  const pele = await import("pele");
  const peleImportMs = performance.now() - peleStart;

  const engines = {
    mermaid: {
      version: readVersion("mermaid"),
      importMs: mermaidImportMs,
      parseMs: 0,
      parseCount: 0,
    },
    pele: {
      version: readVersion("pele"),
      importMs: peleImportMs,
      parseMs: 0,
      parseCount: 0,
    },
  };

  return {
    engines,
    parseWithMermaid: async (code) => {
      const start = performance.now();
      try {
        await mermaid.parse(code);
        return { ok: true, error: undefined };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        engines.mermaid.parseMs += performance.now() - start;
        engines.mermaid.parseCount += 1;
      }
    },
    parseWithPele: (code) => {
      const start = performance.now();
      const result = (() => {
        try {
          pele.parse(code);
          return { ok: true, error: undefined, renderError: undefined };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            renderError: undefined,
          };
        }
      })();
      engines.pele.parseMs += performance.now() - start;
      engines.pele.parseCount += 1;
      return result;
    },
  };
}

async function main() {
  const { roots, out } = parseArgs(process.argv.slice(2));
  const { engines, parseWithMermaid, parseWithPele } = await loadEngines();

  /** @type {{ location: string, origin: "fence" | "artifact", body: string }[]} */
  const blocks = [];
  for (const root of roots) {
    const absolute = path.resolve(REPO_ROOT, root);
    if (!statSync(absolute, { throwIfNoEntry: false })) continue;

    for (const file of walkFiles(absolute, (candidate) =>
      candidate.endsWith(".md"),
    )) {
      const markdown = readFileSync(file, "utf8");
      for (const fence of collectMermaidFences(markdown)) {
        blocks.push({
          location: `${relative(file)}:${fence.startLine}`,
          origin: "fence",
          body: fence.body,
        });
      }
    }
    for (const file of walkFiles(absolute, (candidate) =>
      candidate.endsWith("artifact.json"),
    )) {
      for (const node of collectArtifactMermaidNodes(
        readFileSync(file, "utf8"),
      )) {
        blocks.push({
          location: `${relative(file)}${node.path}`,
          origin: "artifact",
          body: node.body,
        });
      }
    }
  }

  const results = [];
  for (const block of blocks) {
    const mermaid = await parseWithMermaid(block.body);
    const pele = parseWithPele(block.body);
    results.push({
      ...block,
      diagramType: detectDiagramType(block.body),
      kind: classifyDivergence(mermaid, pele),
      mermaid,
      pele,
    });
  }

  const report = summarizeReport({ results, engines, sources: roots });
  const outPath = path.resolve(REPO_ROOT, out);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, report);

  const counts = countDivergences(results);
  console.log(`blocks: ${results.length}`);
  for (const [kind, count] of Object.entries(counts))
    console.log(`  ${kind}: ${count}`);
  console.log(`report: ${outPath}`);
  process.exit(counts["mermaid-only-ok"] > 0 ? 1 : 0);
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  await main();
}
