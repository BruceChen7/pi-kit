---
description: Debug browser-only bugs with opencli using live page interaction, DOM inspection, network/WS instrumentation, and backend cross-checks
argument-hint: "[url] [focus] [extra-instructions]"
---
Debug a real browser issue with `opencli`.

Arguments:
- `$1` = optional URL or starting page
- `$2` = optional focus area, such as `layout`, `network`, `ws`, `auth`, `state`, `timing`, `switching`, or `full`
- remaining args = extra user instructions, repro hints, or app-specific constraints

## Mission
Use `opencli` to reproduce and diagnose bugs that only show up in a real browser, especially when static code reading is not enough.

Examples:
- layout issues: width/height not filling, overflow, clipping, wrong responsive behavior
- interaction issues: click works visually but state is wrong, form input not committed, route transition bugs
- timing issues: page changes before layout settles, race conditions, stale refs, reconnect problems
- protocol issues: missing network request, missing WebSocket auth/resize/event frame, wrong payload ordering
- backend sync issues: frontend state diverges from server/session/process state

## Required workflow
1. Read the relevant code paths before changing anything.
2. Run `opencli doctor` first.
3. Reproduce in a real browser session with `opencli browser`.
4. Gather evidence before proposing fixes.
5. Cross-check frontend observations against backend/runtime state when the app depends on servers, sockets, sessions, workers, or subprocesses.

## Core debugging loop

### A. Establish the repro
- Open the target page with `opencli browser <session> open <url>`
- Run `state` first
- Log in or navigate as needed
- Reproduce the bug with the minimum reliable sequence
- If refs become stale after navigation or rerender, refresh with `state` again

### B. Inspect the visible state
Use `opencli browser <session> state`, `find`, `get`, and `eval` to inspect:
- the active page state
- the relevant DOM subtree
- element sizes/positions when layout is involved
- current field values after interactions
- route/title/url changes after navigation

When layout is relevant, measure with `eval`:
- container and child `clientWidth/clientHeight`
- bounding-box width/height/x/y
- scroll size vs client size
- computed styles when needed

### C. Instrument the browser when needed
Use in-page monkey-patching via `opencli browser <session> eval` for evidence gathering.

Common targets:
- `WebSocket.prototype.send` / message handling
- `window.fetch`
- `XMLHttpRequest`
- event listeners
- app-global state exposed on `window`
- timers or retry counters when timing is suspect

Record structured evidence such as:
- timestamp
- event type
- target URL / session id / route
- payload summary
- ordering between auth, state sync, resize, navigation, and render-related events

### D. Compare browser evidence against runtime truth
If the app talks to a backend or local runtime, compare browser evidence with the real system state.

Depending on the app, this may include:
- HTTP/API logs
- WebSocket server logs
- database state
- tmux/session/process state
- worker/subprocess status
- local files or caches

Answer explicitly:
- what the browser thinks happened
- what the backend/runtime thinks happened
- where they diverge
- whether the issue is missing event emission, bad timing, stale bookkeeping, or cleanup failure

### E. Stress the repro path
If the bug involves transitions or races, repeat the action multiple times.
Examples:
- switch between views/sessions repeatedly
- toggle responsive widths
- reconnect several times
- submit/cancel in quick succession
- navigate back/forward and re-open the same UI

Look for:
- stale cleanup
- duplicated listeners
- leaked sockets/clients/processes
- dropped messages
- early measurement before layout settles
- old state overwriting new state

## Focus-specific guidance
- `layout`: prioritize DOM measurements, flex/grid constraints, overflow, fit timing, responsive breakpoints
- `network`: prioritize fetch/XHR capture, request order, missing calls, payload/body shape, caching behavior
- `ws`: prioritize auth frames, message order, reconnect logic, missing control frames, stale socket effects
- `auth`: prioritize login flow, token propagation, first-request ordering, protected-route behavior
- `state`: prioritize UI state transitions, stale refs, cross-view contamination, local vs server truth
- `timing`: prioritize RAF/tick/layout-settle timing, retries, reconnects, delayed handlers, cleanup races
- `switching`: prioritize view/session/tab/context switch sequencing and old-state teardown
- `full`: combine all relevant paths

## Deliverable
Return a concise debugging report with:
1. exact repro steps
2. evidence gathered from opencli and any backend/runtime checks
3. root cause hypothesis or confirmed root cause
4. exact files/functions/modules involved
5. if fixed, what changed and how it was verified

If you change code, rerun the checks and rerun the live opencli repro to confirm the bug is actually gone.

Target URL: ${1:-<user-provided-or-detect-during-debug>}
Focus: ${2:-full}
Extra user instructions: ${@:3}
