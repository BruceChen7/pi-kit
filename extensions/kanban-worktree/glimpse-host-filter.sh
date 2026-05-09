#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${KANBAN_GLIMPSE_REAL_HOST:-}" ]]; then
  echo "KANBAN_GLIMPSE_REAL_HOST is required" >&2
  exit 127
fi

log_path="${KANBAN_GLIMPSE_STDERR_LOG:-${HOME}/.pi/agent/kanban-worktree/glimpse-stderr.log}"
mkdir -p "$(dirname "$log_path")"

"$KANBAN_GLIMPSE_REAL_HOST" "$@" 2>>"$log_path"
