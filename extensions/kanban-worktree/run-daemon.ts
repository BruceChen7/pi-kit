#!/usr/bin/env node
import { parseArgs } from "node:util";

import { KanbanDaemon } from "./daemon.ts";
import { createKanbanLogger } from "./logger.ts";

const { values, positionals } = parseArgs({
  options: {
    socket: { type: "string" },
    root: { type: "string" },
    metadata: { type: "string" },
    "repo-root": { type: "string" },
  },
  allowPositionals: true,
});

const socketPath = values.socket ?? positionals[0];
const rootDir = values.root;
const metadataPath = values.metadata;
const repoRoot = values["repo-root"];
const logger = createKanbanLogger("entrypoint");
logger.info("starting", {
  socketPath,
  rootDir: rootDir ?? null,
  metadataPath: metadataPath ?? null,
  repoRoot: repoRoot ?? null,
});
const daemon = new KanbanDaemon({
  socketPath,
  metadataPath,
  rootDir,
  repoRoot,
});
await daemon.listen();
