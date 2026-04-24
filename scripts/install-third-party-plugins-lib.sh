#!/bin/bash

get_settings_file() {
    local scope="$1"
    local script_dir="$2"

    if [ "$scope" = "-l" ]; then
        printf '%s/.pi/settings.json\n' "$script_dir"
    else
        printf '%s/.pi/agent/settings.json\n' "$HOME"
    fi
}

parse_github_shorthand() {
    local plugin="$1"
    local source=""
    local repo=""
    local ref=""

    [[ "$plugin" == github:* ]] || return 1

    source="${plugin#github:}"
    [ -n "$source" ] || return 1
    [[ "$source" == */* ]] || return 1

    if [[ "$source" == *@* ]]; then
        repo="${source%@*}"
        ref="${source##*@}"
        [ -n "$repo" ] || return 1
        [ -n "$ref" ] || return 1
        [[ "$repo" != *@* ]] || return 1
        [[ "$ref" != *@* ]] || return 1
    else
        repo="$source"
    fi

    [[ "$repo" == */* ]] || return 1
    [[ "$repo" != */*/* ]] || return 1

    printf '%s\t%s\n' "$repo" "$ref"
}

parse_github_https_source() {
    local plugin="$1"
    local source=""
    local repo_path=""
    local repo=""
    local ref=""

    [[ "$plugin" == https://github.com/* ]] || return 1

    source="${plugin#https://github.com/}"
    [ -n "$source" ] || return 1
    [[ "$source" == */* ]] || return 1

    if [[ "$source" == *@* ]]; then
        repo_path="${source%@*}"
        ref="${source##*@}"
        [ -n "$repo_path" ] || return 1
        [ -n "$ref" ] || return 1
        [[ "$repo_path" != *@* ]] || return 1
        [[ "$ref" != *@* ]] || return 1
    else
        repo_path="$source"
    fi

    repo="${repo_path%.git}"

    [[ "$repo" == */* ]] || return 1
    [[ "$repo" != */*/* ]] || return 1

    printf '%s\t%s\n' "$repo" "$ref"
}

normalize_plugin_source() {
    local plugin="$1"
    local parsed=""
    local repo=""
    local ref=""

    if [[ "$plugin" == npm:* ]]; then
        printf '%s\n' "$plugin"
        return 0
    fi

    if parsed="$(parse_github_shorthand "$plugin")"; then
        repo="${parsed%%$'\t'*}"
        ref="${parsed#*$'\t'}"
        printf 'git:github.com/%s' "$repo"
        if [ -n "$ref" ]; then
            printf '@%s' "$ref"
        fi
        printf '\n'
        return 0
    fi

    printf '%s\n' "$plugin"
}

get_equivalent_sources() {
    local plugin="$1"
    local parsed=""
    local repo=""
    local ref=""
    local suffix=""

    if [[ "$plugin" == npm:* ]]; then
        printf '%s\n' "$plugin"
        printf '%s\n' "${plugin#npm:}"
        return 0
    fi

    if parsed="$(parse_github_shorthand "$plugin")" || parsed="$(parse_github_https_source "$plugin")"; then
        repo="${parsed%%$'\t'*}"
        ref="${parsed#*$'\t'}"
        if [ -n "$ref" ]; then
            suffix="@$ref"
        fi

        printf 'github:%s%s\n' "$repo" "$suffix"
        printf 'git:github.com/%s%s\n' "$repo" "$suffix"
        printf 'https://github.com/%s%s\n' "$repo" "$suffix"
        printf 'https://github.com/%s.git%s\n' "$repo" "$suffix"
        return 0
    fi

    printf '%s\n' "$plugin"
}

settings_contains_package() {
    local settings_file="$1"
    shift

    [ -f "$settings_file" ] || return 1

    node - "$settings_file" "$@" <<'JS'
const fs = require("node:fs");

const [, , settingsFile, ...candidates] = process.argv;
const candidateSet = new Set(candidates);

let settings;
try {
  settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
} catch {
  process.exit(1);
}

if (!Array.isArray(settings.packages)) process.exit(1);

process.exit(
  settings.packages.some(
    (packageSource) =>
      typeof packageSource === "string" && candidateSet.has(packageSource),
  )
    ? 0
    : 1,
);
JS
}

is_installed() {
    local plugin="$1"
    local settings_file="$2"
    local candidate=""
    local candidates=()

    while IFS= read -r candidate; do
        [ -n "$candidate" ] || continue
        candidates+=("$candidate")
    done < <(get_equivalent_sources "$plugin")

    [ "${#candidates[@]}" -gt 0 ] || return 1

    settings_contains_package "$settings_file" "${candidates[@]}"
}
