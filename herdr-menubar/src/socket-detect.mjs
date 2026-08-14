// socket-detect.mjs — 定位 herdr API socket。
// 优先级:HERDR_SOCKET_PATH 环境变量 → ~/.config/herdr/herdr.sock → ~/.config/herdr/sessions/*/herdr.sock
// 返回 [{ path, name }],name 用于区分多个 herdr 实例(default / 会话名)。
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function configDir() {
  if (process.env.HERDR_CONFIG_DIR) return process.env.HERDR_CONFIG_DIR;
  return join(homedir(), ".config", "herdr");
}

export function listSocketPaths() {
  const dir = configDir();
  const found = [];

  if (process.env.HERDR_SOCKET_PATH) {
    found.push({ path: process.env.HERDR_SOCKET_PATH, name: "default" });
    return found; // 显式指定时只连这一个
  }

  const main = join(dir, "herdr.sock");
  if (existsSync(main)) found.push({ path: main, name: "default" });

  // named sessions: ~/.config/herdr/sessions/<name>/herdr.sock
  try {
    const sessionsDir = join(dir, "sessions");
    for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sock = join(sessionsDir, entry.name, "herdr.sock");
      if (existsSync(sock)) found.push({ path: sock, name: entry.name });
    }
  } catch {
    /* sessions 目录不存在则忽略 */
  }

  return found;
}
