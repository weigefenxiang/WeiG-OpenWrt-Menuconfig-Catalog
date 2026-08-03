#!/usr/bin/env bash
set -uo pipefail

repo_url="${1:?repository URL is required}"
branch="${2:?branch is required}"
destination="${3:?destination is required}"
max_attempts="${CLONE_MAX_ATTEMPTS:-3}"

if ! [[ "$max_attempts" =~ ^[1-5]$ ]]; then
  echo "CLONE_MAX_ATTEMPTS must be an integer from 1 to 5" >&2
  exit 2
fi

# The workflow owns this path. Refuse other paths before removing a partial clone.
case "$destination" in
  work/upstream) ;;
  *) echo "refusing unsafe clone destination: $destination" >&2; exit 2 ;;
esac

is_transient_failure() {
  grep -Eqi \
    'returned error: (408|429|500|502|503|504)|Could not resolve host|Connection reset|Connection timed out|Operation timed out|TLS connection|SSL|early EOF|Empty reply|remote end hung up' \
    "$1"
}

attempt_log=""
trap 'rm -f -- "$attempt_log"' EXIT

for ((attempt = 1; attempt <= max_attempts; attempt++)); do
  rm -rf -- "$destination"
  attempt_log="$(mktemp)"
  echo "[clone] attempt ${attempt}/${max_attempts}: ${repo_url} @ ${branch}"
  if GIT_TERMINAL_PROMPT=0 git clone --branch "$branch" --depth 1 "$repo_url" "$destination" >"$attempt_log" 2>&1; then
    cat "$attempt_log"
    echo "[clone] succeeded on attempt ${attempt}/${max_attempts}"
    exit 0
  else
    status=$?
  fi

  cat "$attempt_log"
  if (( attempt < max_attempts )) && is_transient_failure "$attempt_log"; then
    delay=$(( attempt == 1 ? 5 : 15 ))
    echo "[clone] transient network failure (exit ${status}); retrying in ${delay}s"
    rm -f -- "$attempt_log"
    attempt_log=""
    sleep "$delay"
    continue
  fi

  if is_transient_failure "$attempt_log"; then
    echo "[clone] transient network failure persisted after ${attempt}/${max_attempts} attempts"
  else
    echo "[clone] permanent clone failure; no retry"
  fi
  exit "$status"
done

exit 1
