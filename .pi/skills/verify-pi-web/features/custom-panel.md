# Custom panel

A plugin that opens `ctx.ui.custom()` gets a real panel in pi-web: the component's `render(width)` lines become browser text inside a dialog, keyboard input reaches the panel, and Escape closes it and resolves the command.

This is the surface that separates pi-web from pi's own rpc mode, where the same call resolves `undefined` without ever asking the host.

## Sub-features

- `panel-open` shows a `role=dialog` element for a `ctx.ui.custom()` request.
- `panel-content` renders the plugin's own rendered text inside that dialog.
- `panel-close` closes it with Escape and lets the command finish.

## How to get to it (user POV)

- Type `/toggle-skill` in the composer and press Enter.
- Read the picker, then press Escape or choose the close button.

## Driving it with verify-pi-web

Preconditions:
- `doctor --plugin skill-toggle --expect-command toggle-skill` passes on this run.
- Browser session `piweb-probe` is open on the project (`?cwd=…`).
- No other panel is open: `opencli browser piweb-probe find --css 'div[role="dialog"]'` reports zero matches.

- **Open the panel.** Send `/toggle-skill`. Run `opencli browser piweb-probe fill ".chat-input-textarea" "/toggle-skill"`, `opencli browser piweb-probe click ".chat-input-textarea"`, `opencli browser piweb-probe keys Enter`. The composer clears and the command's user message appears. If the text is still in the box, the send was dropped: click and press Enter again.
- **Assert the panel.** Run `opencli browser piweb-probe find --css 'div[role="dialog"]'`. One match, and `opencli browser piweb-probe state` shows the picker's own text inside it, starting with `Skill Picker (`. That text comes from the plugin's `render()`, not from pi-web.
- **Proof.** Capture both: `opencli browser piweb-probe screenshot <runDir>/evidence/custom-panel.png` and `opencli browser piweb-probe state > <runDir>/evidence/custom-panel.state.txt`. The snapshot must contain the `role=dialog` element and a line naming the picker.
- **Close.** Run `opencli browser piweb-probe keys Escape`. `find --css 'div[role="dialog"]'` reports zero matches and the composer returns to its normal `消息…` placeholder state.

## Gotchas

- Do not type into the composer while a panel is open. pi-web swaps the composer for the running state and the panel owns the keyboard; a stray `fill` leaves half a command in the box and the next send mixes both.
- Do not press Enter inside a picker to "just close it". Enter commits the highlighted row and writes user-level state (skill toggles). Escape is the read-only exit.
- The panel's close button label is localized (`关闭` / `Close`). Select the dialog element or press Escape instead of matching that text.
- The picker lists whatever skills the machine has, so the count varies per machine. Assert the `Skill Picker (` prefix, never the number.
- The command stays unresolved until the panel closes. A `stop` that runs before Escape leaves the session mid-command; close the panel first, then stop.
