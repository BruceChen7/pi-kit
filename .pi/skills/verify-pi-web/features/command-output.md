# Command output

A slash command handled by a pi-kit plugin writes its result where the browser user can read it: a line in the transcript, and a `setStatus` status line under the composer.

## Sub-features

- `output-transcript` renders the handler's text output as a transcript entry.
- `output-status` renders `ctx.ui.setStatus` as a `role=status` line whose accessible name is the plugin's text.
- `output-restore` returns the session to its starting mode so the next recipe starts clean.

## How to get to it (user POV)

- Type `/plan-mode status` in the composer and press Enter.
- Type `/plan-mode plan` to see the status line; `/plan-mode act` clears it.

## Driving it with verify-pi-web

Preconditions:
- `doctor --plugin plan-mode --expect-command plan-mode` passes on this run.
- Browser session `piweb-probe` is open on `http://127.0.0.1:30242/?cwd=<urlencoded cwd>`.

- **Open the project.** Run `CWD=$(node -e 'console.log(encodeURIComponent(process.cwd()))')` then `opencli browser piweb-probe open "http://127.0.0.1:30242/?cwd=$CWD"`. The composer is visible: `opencli browser piweb-probe find --css ".chat-input-textarea"` reports one match.
- **Read status.** Fill `"/plan-mode status"`, click the composer, press Enter. Run `opencli browser piweb-probe fill ".chat-input-textarea" "/plan-mode status"`, `opencli browser piweb-probe click ".chat-input-textarea"`, `opencli browser piweb-probe keys Enter`. The composer clears and a transcript entry appears containing `Plan Mode:` and `status:`. If the text is still in the box, the send was dropped: click and press Enter again.
- **Show the status line.** Send `"/plan-mode plan"` the same way. `opencli browser piweb-probe state` contains `role=status aria-label=Plan Mode: Plan · Planning` — the accessible name is exactly the plugin's `setStatus` string, and the same text renders inside the element. Assert on that name, not on styling.
- **Proof.** Capture both: `opencli browser piweb-probe screenshot <runDir>/evidence/command-output.png` and `opencli browser piweb-probe state > <runDir>/evidence/command-output.state.txt`. The snapshot must contain the `role=status` element or the transcript line, not just a shell.
- **Restore.** Send `"/plan-mode act"`. The `role=status` element disappears from `state`.

## Gotchas

- Assert plugin text (`Plan Mode:`, `status:`), never pi-web chrome: the UI locale follows the browser, so the same panel reads `扩展面板` or `Extension panel`.
- `fill` sets the value but does not focus the composer, so a following `keys Enter` sends nothing and leaves the text in the box. Always `click` the composer between the two.
- The send button carries a localized `title` (`发送` in zh, `Send` in en). Prefer Enter over selecting that button.
- Leaving the session in Plan mode makes the next recipe's status assertion ambiguous. Always finish with `/plan-mode act`.
- A transcript line alone does not prove the browser rendered it; the state snapshot from the same moment does.
