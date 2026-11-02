#!/usr/bin/env bash
# The GitHub Action's one step (../action.yml): runs `furan upload` with the
# @furan/cli version of this checkout. Inputs arrive only as INPUT_*
# environment variables (never interpolated into a script) and arguments are
# built as an array, so no input can inject shell. Kept to bash 3.2, so it also
# runs on macOS runners' /bin/bash.
set -euo pipefail
shopt -s globstar 2>/dev/null || true
shopt -s nullglob

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  printf '%s' "${s%"${s##*[![:space:]]}"}"
}

truthy() {
  case "$(trim "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    true | 1 | yes) return 0 ;;
    *) return 1 ;;
  esac
}

# Connection settings: only when the input is set, so a job-level FURAN_* env
# still applies.
[ -n "${INPUT_API_URL:-}" ] && export FURAN_API_URL="$INPUT_API_URL"
[ -n "${INPUT_TOKEN:-}" ] && export FURAN_API_TOKEN="$INPUT_TOKEN"
[ -n "${INPUT_PROJECT_ID:-}" ] && export FURAN_PROJECT_ID="$INPUT_PROJECT_ID"
[ -n "${INPUT_DASHBOARD_URL:-}" ] && export FURAN_DASHBOARD_URL="$INPUT_DASHBOARD_URL"

version="$(trim "${INPUT_VERSION:-}")"
if [ -z "$version" ]; then
  version="$(node -p 'require(process.env.GITHUB_ACTION_PATH + "/package.json").version')"
fi

# One path or glob per line; a line that matches nothing is passed as-is so
# the CLI reports it.
paths=()
while IFS= read -r raw || [ -n "$raw" ]; do
  line="$(trim "$raw")"
  [ -z "$line" ] && continue
  found=0
  while IFS= read -r match; do
    [ -z "$match" ] && continue
    paths+=("$match")
    found=1
  done < <(compgen -G "$line" || true)
  [ "$found" = 1 ] || paths+=("$line")
done <<<"${INPUT_PATH:-}"
if [ "${#paths[@]}" -eq 0 ]; then
  echo "furan action: the path input is required (one PNG file, folder or glob per line)" >&2
  exit 2
fi

flags=()
[ -n "$(trim "${INPUT_TEST:-}")" ] && flags+=(--test "$(trim "$INPUT_TEST")")
while IFS= read -r raw || [ -n "$raw" ]; do
  line="$(trim "$raw")"
  [ -n "$line" ] && flags+=(--ignore "$line")
done <<<"${INPUT_IGNORE:-}"
[ -n "$(trim "${INPUT_MATCH_LEVEL:-}")" ] && flags+=(--match-level "$(trim "$INPUT_MATCH_LEVEL")")
[ -n "$(trim "${INPUT_BROWSER:-}")" ] && flags+=(--browser "$(trim "$INPUT_BROWSER")")
truthy "${INPUT_SAVE_NEW_TESTS:-}" && flags+=(--save-new-tests)
truthy "${INPUT_FAIL_ON_NEW:-}" && flags+=(--fail-on-new)
if [ -n "$(trim "${INPUT_WAIT:-}")" ] && ! truthy "${INPUT_WAIT:-}"; then
  flags+=(--no-wait)
fi
[ -n "$(trim "${INPUT_TIMEOUT:-}")" ] && flags+=(--timeout "$(trim "$INPUT_TIMEOUT")")
while IFS= read -r raw || [ -n "$raw" ]; do
  line="$(trim "$raw")"
  [ -n "$line" ] && flags+=("$line")
done <<<"${INPUT_ARGS:-}"

exec npx -y "@furan/cli@${version}" upload "${paths[@]}" ${flags[@]+"${flags[@]}"}
