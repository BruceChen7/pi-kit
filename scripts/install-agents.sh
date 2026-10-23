#!/usr/bin/env bash
# 把仓库根 agents/*.md 软链到 Pi 的用户级 agent 目录。
#
#   ./scripts/install-agents.sh           安装或刷新软链
#   ./scripts/install-agents.sh --check   只核对，不改盘；有漂移退出非零
#
# 落点是 $HOME/.pi/agent/agents，对应 extensions/subagent/index.ts 的 userDir()。
# 用软链而不是拷贝：仓库是唯一真源，改完立刻生效，不需要重跑。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$SCRIPT_DIR/agents"
TARGET_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}/agents"

check_only=false
if [[ "${1:-}" == "--check" ]]; then
  check_only=true
fi

if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "找不到源目录：$SOURCE_DIR" >&2
  exit 1
fi

missing=()
wrong=()
dangling=()
other=()

for source in "$SOURCE_DIR"/*.md; do
  [[ -e "$source" ]] || continue
  name="$(basename "$source")"
  target="$TARGET_DIR/$name"

  if [[ -L "$target" ]]; then
    if [[ "$(readlink "$target")" != "$source" ]]; then
      wrong+=("$name -> $(readlink "$target")")
    fi
  elif [[ -e "$target" ]]; then
    wrong+=("$name 是普通文件，会遮住仓库里的定义")
  else
    missing+=("$name")
  fi
done

if [[ -d "$TARGET_DIR" ]]; then
  for target in "$TARGET_DIR"/*.md; do
    [[ -L "$target" ]] || continue
    resolved="$(readlink "$target")"
    if [[ "$resolved" == "$SOURCE_DIR"/* && ! -e "$resolved" ]]; then
      dangling+=("$(basename "$target")")
    fi
  done
  for target in "$TARGET_DIR"/*; do
    [[ -e "$target" || -L "$target" ]] || continue
    name="$(basename "$target")"
    [[ "$name" == *.md ]] || continue
    if [[ ! -e "$SOURCE_DIR/$name" && ! -L "$target" ]]; then
      other+=("$name")
    fi
  done
fi

if [[ ${#other[@]} -gt 0 ]]; then
  echo "提示：$TARGET_DIR 里另有非本仓库定义的 profile：${other[*]}"
fi

if [[ ${#missing[@]} -eq 0 && ${#wrong[@]} -eq 0 && ${#dangling[@]} -eq 0 ]]; then
  echo "agents 检查通过：$TARGET_DIR 与 $SOURCE_DIR 一致"
  exit 0
fi

if [[ "$check_only" == true ]]; then
  [[ ${#missing[@]} -gt 0 ]] && echo "缺软链：${missing[*]}" >&2
  [[ ${#wrong[@]} -gt 0 ]] && echo "软链不对：${wrong[*]}" >&2
  [[ ${#dangling[@]} -gt 0 ]] && echo "悬空软链：${dangling[*]}" >&2
  echo "跑 ./scripts/install-agents.sh 修复" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"
for name in "${missing[@]+"${missing[@]}"}"; do
  ln -s "$SOURCE_DIR/$name" "$TARGET_DIR/$name"
  echo "链接 $name"
done
for name in "${dangling[@]+"${dangling[@]}"}"; do
  rm -f "$TARGET_DIR/$name"
  echo "清掉悬空 $name"
done

if [[ ${#wrong[@]} -gt 0 ]]; then
  echo "以下项需要人工处理，本脚本不覆盖非本仓库的文件：${wrong[*]}" >&2
  exit 1
fi

echo "agents 安装完成：$TARGET_DIR"
