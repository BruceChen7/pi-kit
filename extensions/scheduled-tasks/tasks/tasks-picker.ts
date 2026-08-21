/**
 * tasks-picker.ts — TUI picker for manually triggering a deferred task.
 *
 * Extracted from index.ts so the extension entry point stays focused on
 * lifecycle wiring. The rendering logic is pure presentation: it receives a
 * pre-built list of SelectItems (already formatted with relative times by the
 * caller) and resolves with the chosen task id, or null on cancel.
 */
import {
  DynamicBorder,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";

/**
 * Show an interactive task picker and resolve with the selected task id,
 * or null if the user cancels.
 *
 * @param ui - The extension UI context (ctx.ui) that owns the custom renderer.
 * @param items - Pre-built SelectItems (labels/descriptions already formatted).
 */
export function pickTask(
  ui: ExtensionContext["ui"],
  items: SelectItem[],
): Promise<string | null> {
  return ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();

    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(
      new Text(
        theme.fg("accent", theme.bold("Select a task to run manually")),
        1,
        0,
      ),
    );

    const selectList = new SelectList(items, Math.min(items.length, 10), {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });

    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(null);
    container.addChild(selectList);

    container.addChild(
      new Text(
        theme.fg("dim", "↑↓ navigate • enter to trigger • esc cancel"),
        1,
        0,
      ),
    );
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (w) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });
}
