import { matchesKey } from "@earendil-works/pi-tui";
import { panelPainter } from "../shared/panel-chrome.ts";
import type { PanelChrome } from "../shared/ui-host.ts";
import { PICKER_PAGE_SIZE } from "./constants.ts";
import type { PluginEntry } from "./types.ts";
import { normalizeName } from "./utils.ts";

function filterPlugins(plugins: PluginEntry[], query: string): PluginEntry[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return plugins;
  return plugins.filter((plugin) =>
    plugin.name.toLowerCase().includes(normalized),
  );
}

export class PluginTogglePicker {
  private filtered: PluginEntry[];
  private selected = 0;
  private query = "";

  constructor(
    private plugins: PluginEntry[],
    private enabled: Set<string>,
    private onToggle: (plugin: PluginEntry) => void,
    private onClose: () => void,
    private onUpdate: () => void,
    /** 外框策略（见 shared/panel-chrome.ts）：pi-web 这类宿主传 "borderless"。 */
    private chrome: PanelChrome = "boxed",
  ) {
    this.filtered = plugins;
  }

  getSelectedName(): string | null {
    return this.filtered[this.selected]?.name ?? null;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.onClose();
      return;
    }
    if (matchesKey(data, "return")) {
      const plugin = this.filtered[this.selected];
      if (plugin) this.onToggle(plugin);
      return;
    }
    if (matchesKey(data, "up")) {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, "down")) {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, "backspace")) {
      this.query = this.query.slice(0, -1);
      this.updateFilter();
      return;
    }
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.query += data;
      this.updateFilter();
    }
  }

  private moveSelection(delta: -1 | 1): void {
    const lastIndex = Math.max(0, this.filtered.length - 1);
    this.selected = Math.min(lastIndex, Math.max(0, this.selected + delta));
  }

  private updateFilter(): void {
    this.filtered = filterPlugins(this.plugins, this.query);
    this.selected = 0;
    this.onUpdate();
  }

  render(width: number): string[] {
    const painter = panelPainter(this.chrome);
    const border = (text: string) => `\x1b[2m${text}\x1b[0m`;
    const active = (text: string) => `\x1b[36m${text}\x1b[0m`;
    const muted = (text: string) => `\x1b[2m${text}\x1b[0m`;
    const reverse = (text: string) => `\x1b[7m${text}\x1b[0m`;
    const row = (content: string, isSelected = false) =>
      painter.rowLine({
        width,
        content,
        paintBorder: border,
        decorate: isSelected ? reverse : undefined,
      });
    const pluginRowContent = (plugin: PluginEntry, isSelected: boolean) => {
      const marker = isSelected ? "▸" : "·";
      const isEnabled = this.enabled.has(normalizeName(plugin.name));
      const enabledMark = isEnabled ? "✓" : " ";
      if (isSelected || !isEnabled) {
        return `${marker} ${enabledMark} ${plugin.name}`;
      }
      return `${marker} ${active(enabledMark)} ${plugin.name}`;
    };
    const lines = [
      painter.titleLine({
        width,
        title: ` Plugin Picker (${this.enabled.size}) `,
        paintTitle: active,
        paintBorder: border,
      }),
    ];
    lines.push(row(`Search: ${this.query || muted("type to filter...")}`));
    lines.push(painter.ruleLine({ width, paintBorder: border }));
    const pageStart =
      Math.floor(this.selected / PICKER_PAGE_SIZE) * PICKER_PAGE_SIZE;
    const visiblePlugins = this.filtered.slice(
      pageStart,
      pageStart + PICKER_PAGE_SIZE,
    );
    for (let i = 0; i < visiblePlugins.length; i++) {
      const plugin = visiblePlugins[i];
      const pluginIndex = pageStart + i;
      const isSelected = pluginIndex === this.selected;
      lines.push(row(pluginRowContent(plugin, isSelected), isSelected));
    }
    if (this.filtered.length === 0)
      lines.push(row(muted("No matching plugins")));
    lines.push(painter.ruleLine({ width, paintBorder: border }));
    lines.push(row(muted("↑/↓ navigate  enter toggle  esc cancel")));
    const bottom = painter.bottomLine({ width, paintBorder: border });
    if (bottom !== undefined) lines.push(bottom);
    return lines;
  }

  invalidate(): void {}
  dispose(): void {}
}
