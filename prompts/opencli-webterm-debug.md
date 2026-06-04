---
description: Specialize the generic browser-debug workflow for pi-webterm
argument-hint: "[url] [focus: width|pty|switch|full] [extra-instructions]"
---
Use `browser-debug` as the base workflow, then apply these `pi-webterm`-specific checks.

Defaults:
- URL: `${1:-http://127.0.0.1:4730}`
- Focus: `${2:-full}`

## pi-webterm specialization
Prioritize these areas:
- xterm layout and fit timing
- session switching and reconnect ordering
- WebSocket auth/resize frame ordering
- frontend cols/rows vs backend PTY size
- stale tmux client residue, especially old `80x24` clients

## Extra checks for pi-webterm
When relevant, include:
- DOM measurements for:
  - `.main-layout`
  - `.sidebar`
  - `.main-area`
  - `.terminal-container`
  - `.xterm`
  - `.xterm-screen`
  - `.xterm-viewport`
- WebSocket instrumentation for auth and resize frames
- backend tmux cross-checks such as:
  - `tmux list-windows -t <session> -F '#{session_name} #{window_width} #{window_height}'`
  - `tmux list-clients -t <session> -F '#{client_width} #{client_height} #{session_name}'`

Target URL: ${1:-http://127.0.0.1:4730}
Focus: ${2:-full}
Extra user instructions: ${@:3}
