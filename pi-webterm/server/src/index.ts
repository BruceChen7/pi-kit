import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { registerRoutes } from "./api.js";
import {
  assertSafeBindAuthConfig,
  type CliArgs,
  getConfig,
  loadConfig,
} from "./config.js";

export type { CliArgs };

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const UI_DIST = join(__dirname, "..", "..", "ui", "dist");

/**
 * Create and configure the Pi WebTerm server.
 */
export async function createServer(
  args: CliArgs = {},
): Promise<FastifyInstance> {
  loadConfig(args);
  const cfg = getConfig();

  // Security guard: prevent weak passwords on network-reachable bind hosts
  assertSafeBindAuthConfig(cfg.host, cfg.password);

  const fastify = Fastify({
    logger: {
      level: cfg.port === 0 ? "silent" : "info",
    },
  });

  // CORS for mobile browsers
  await fastify.register(import("@fastify/cors"), {
    origin: "*",
  });

  // WebSocket support
  await fastify.register(import("@fastify/websocket"));

  // Register API routes + WebSocket handler
  registerRoutes(fastify, {});

  // Serve static UI if built
  if (existsSync(UI_DIST)) {
    await fastify.register(import("@fastify/static"), {
      root: UI_DIST,
      prefix: "/",
      wildcard: false,
    });
  }

  return fastify;
}

/**
 * Start the server and return the listen URL.
 */
export async function startServer(
  fastify: FastifyInstance,
  port?: number,
  host?: string,
): Promise<string> {
  const cfg = getConfig();
  const addr = await fastify.listen({
    port: port ?? cfg.port,
    host: host ?? cfg.host,
  });
  return addr;
}

/**
 * Main entry point (CLI).
 */
async function main() {
  const args = parseArgs();
  const server = await createServer(args);
  const url = await startServer(server);
  const cfg = getConfig();
  console.log(`\n  🔗 Pi WebTerm running at: ${url}\n`);
  console.log(`  📱 Mobile: http://<your-ip>:${cfg.port}/`);
  console.log(
    `  🔑 Login: username="${cfg.username}" password="${cfg.password}"`,
  );
  console.log(
    `  💡 Custom credentials: npx tsx src/index.ts --username <user> --password <pass>\n`,
  );
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const args: CliArgs = {};

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--port":
      case "-p":
        args.port = Number(argv[++i]);
        break;
      case "--host":
        args.host = argv[++i];
        break;
      case "--username":
      case "-u":
        args.username = argv[++i];
        break;
      case "--password":
      case "-pwd":
        args.password = argv[++i];
        break;
      case "--agent":
        args.agentCommand = argv[++i];
        break;
      case "--cwd":
        args.cwd = argv[++i];
        break;
      case "--no-auto-start":
        args.autoStartAgent = false;
        break;
    }
  }

  return args;
}

// Run if called directly (not when imported as module)
const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main();
}
