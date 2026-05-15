import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_LIBRARY_DIR = path.join(
  os.homedir(),
  ".agents",
  "pi-plugins",
);
export const GLOBAL_EXTENSION_DIR = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "extensions",
);
export const GLOBAL_AUTOLOAD_BOOTSTRAP_ENTRIES = new Set([
  "plugin-toggle",
  "shared",
]);
export const DEFAULT_DISABLED_PLUGINS = [
  "dirty-git-status",
  "remote-approval",
  "copyx",
];
export const PROJECT_EXTENSION_DIR = path.join(".pi", "extensions");
export const PICKER_PAGE_SIZE = 8;
export const SHARED_EXTENSION_NAME = "shared";
export const DEFAULT_BOOTSTRAP_SUCCESS_MESSAGE =
  "同步插件成功，请重启 Pi 以加载新插件。";
export const PLUGIN_TOGGLE_EXTENSION_DIR = path.dirname(
  fileURLToPath(import.meta.url),
);
export const PLUGIN_LIBRARY_MANIFEST = ".manifest.json";
