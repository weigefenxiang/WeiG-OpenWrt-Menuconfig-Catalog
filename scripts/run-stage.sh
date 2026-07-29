#!/usr/bin/env bash
set -uo pipefail

stage="${1:?stage is required}"
shift
log_dir="${GITHUB_WORKSPACE:-$PWD}/failure-logs"
log_file="${RUNNER_TEMP:-/tmp}/catalog-${stage}.log"
started="$(date +%s)"

if "$@" >"$log_file" 2>&1; then
  echo "✓ ${stage} completed in $(( $(date +%s) - started ))s"
  rm -f "$log_file"
  exit 0
fi

mkdir -p "$log_dir"
cp "$log_file" "$log_dir/${stage}.log"
echo "::error::${stage} failed after $(( $(date +%s) - started ))s"
echo "---- key errors ----"
grep -Ei 'error|failed|failure|missing|not found|prerequisite|traceback|cannot|no such file' "$log_file" | tail -n 40 || true
echo "---- last 80 lines ----"
tail -n 80 "$log_file"
exit 1
