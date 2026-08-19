#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 weigefenxiang <weigefenxiang@gmail.com>
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

: "${PROBE_LOG:?PROBE_LOG is required}"

MAX_ATTEMPTS="${PROBE_FEED_MAX_ATTEMPTS:-3}"
ATTEMPT_TIMEOUT_SECONDS="${PROBE_FEED_TIMEOUT_SECONDS:-180}"
RUNTIME_FILE="${PROBE_FEEDS_RUNTIME:-${GITHUB_WORKSPACE:-$(pwd)}/probe-feeds-runtime.json}"

if [[ ! "$MAX_ATTEMPTS" =~ ^[1-3]$ ]]; then
  echo "ERROR: PROBE_FEED_MAX_ATTEMPTS must be 1, 2, or 3."
  exit 2
fi
if [[ ! "$ATTEMPT_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: PROBE_FEED_TIMEOUT_SECONDS must be a positive integer."
  exit 2
fi
if [[ ! -x ./scripts/feeds ]]; then
  echo "ERROR: OpenWrt scripts/feeds is unavailable in $(pwd)."
  exit 2
fi

write_output() {
  local key="$1"
  local value="$2"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s=%s\n' "$key" "$value" >>"$GITHUB_OUTPUT"
  fi
}

network_failure() {
  local file="$1"
  grep -Eqi \
    'RPC failed|HTTP (429|5[0-9]{2})|returned error: (429|5[0-9]{2})|expected .?packfile|early EOF|Connection (timed out|reset)|Could not resolve host|TLS.*(error|failed)|GnuTLS.*error|SSL.*(error|failed)' \
    "$file"
}

mirror_uri_for() {
  local uri="$1"
  local base suffix mirror=''
  base="${uri%%[;^]*}"
  suffix="${uri#"$base"}"
  case "$base" in
    https://git.openwrt.org/feed/packages.git)
      mirror='https://github.com/openwrt/packages.git'
      ;;
    https://git.openwrt.org/project/luci.git)
      mirror='https://github.com/openwrt/luci.git'
      ;;
    https://git.openwrt.org/feed/routing.git)
      mirror='https://github.com/openwrt/routing.git'
      ;;
    https://git.openwrt.org/feed/telephony.git)
      mirror='https://github.com/openwrt/telephony.git'
      ;;
  esac
  [[ -n "$mirror" ]] && printf '%s%s' "$mirror" "$suffix"
}

provider_for_uri() {
  local uri="$1"
  case "$uri" in
    https://git.openwrt.org/*) printf '%s' 'git.openwrt.org' ;;
    https://github.com/openwrt/*) printf '%s' 'github-openwrt' ;;
    *) printf '%s' 'upstream' ;;
  esac
}

ensure_runtime_feeds_config() {
  if [[ -f feeds.conf ]]; then
    return 0
  fi
  if [[ -f feeds.conf.default ]]; then
    cp feeds.conf.default feeds.conf
    return 0
  fi
  echo 'ERROR: feeds.conf and feeds.conf.default are both missing.'
  exit 2
}

feed_uri() {
  local feed="$1"
  ./scripts/feeds list -f | awk -v name="$feed" '$2 == name { print $3; exit }'
}

replace_feed_uri() {
  local feed="$1"
  local new_uri="$2"
  local tmp
  tmp="$(mktemp)"
  awk -v feed="$feed" -v replacement="$new_uri" '
    {
      if ($1 ~ /^src-/) {
        name_col = 0
        for (i = 2; i <= NF; i++) {
          if ($i !~ /^--/) { name_col = i; break }
        }
        if (name_col > 0 && $name_col == feed && name_col + 1 <= NF) {
          $(name_col + 1) = replacement
        }
      }
      print
    }
  ' feeds.conf >"$tmp"
  mv "$tmp" feeds.conf
}

RUNTIME_ROWS="$(mktemp)"
cleanup() {
  rm -f "$RUNTIME_ROWS"
}
trap cleanup EXIT

write_runtime_file() {
  local outcome="$1"
  local failure_reason="${2:-}"
  local failure_feed="${3:-}"
  node - "$RUNTIME_ROWS" "$RUNTIME_FILE" "$outcome" "$failure_reason" "$failure_feed" "${PROBE_SOURCE:-}" "${PROBE_BRANCH:-}" <<'NODE'
const fs = require('node:fs');
const [rowsFile, outputFile, outcome, failureReason, failureFeed, source, branch] = process.argv.slice(2);
const rows = fs.existsSync(rowsFile) ? fs.readFileSync(rowsFile, 'utf8').trim().split(/\n/).filter(Boolean).map((line) => {
  const [name, status, provider, attempts, commit, url] = line.split('\t');
  return { name, status, provider, attempts: Number(attempts || 0), commit, url };
}) : [];
fs.writeFileSync(outputFile, `${JSON.stringify({ schema: 1, source, branch, outcome, failureReason, failureFeed, feeds: rows }, null, 2)}\n`);
NODE
}

record_feed() {
  local feed="$1" status="$2" provider="$3" attempts="$4" commit="$5" uri="$6"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$feed" "$status" "$provider" "$attempts" "$commit" "$uri" >>"$RUNTIME_ROWS"
}

fail_stage() {
  local reason="$1" feed="$2" attempts="$3" uri="$4"
  local provider
  provider="$(provider_for_uri "$uri")"
  record_feed "$feed" 'failure' "$provider" "$attempts" '' "$uri"
  write_runtime_file 'failure' "$reason" "$feed"
  write_output failure_reason "$reason"
  write_output failure_feed "$feed"
  echo "ERROR: Probe feeds failed: reason=${reason} feed=${feed} attempts=${attempts} provider=${provider}." | tee -a "$PROBE_LOG"
  exit 1
}

ensure_runtime_feeds_config
mapfile -t FEEDS < <(./scripts/feeds list -n)
if ((${#FEEDS[@]} == 0)); then
  echo 'ERROR: no feeds were declared by the upstream source.'
  exit 2
fi

for feed in "${FEEDS[@]}"; do
  uri="$(feed_uri "$feed")"
  if [[ -z "$uri" ]]; then
    fail_stage 'feed-config' "$feed" 0 ''
  fi

  for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
    attempt_log="$(mktemp)"
    provider="$(provider_for_uri "$uri")"
    echo "Probe feeds: updating ${feed} attempt ${attempt}/${MAX_ATTEMPTS} via ${provider}."

    set +e
    timeout --signal=TERM --kill-after=20s "${ATTEMPT_TIMEOUT_SECONDS}s" ./scripts/feeds update "$feed" 2>&1 | tee -a "$PROBE_LOG" "$attempt_log"
    status="${PIPESTATUS[0]}"
    set -e

    if ((status == 0)); then
      commit="$(git -C "feeds/${feed}" rev-parse HEAD 2>/dev/null || true)"
      record_feed "$feed" 'success' "$provider" "$attempt" "$commit" "$uri"
      rm -f "$attempt_log"
      break
    fi

    if ((status == 124 || status == 137)); then
      reason='feed-timeout'
    elif network_failure "$attempt_log"; then
      reason='feed-network'
    else
      reason='feed-update'
    fi

    echo "Probe feeds: ${feed} attempt ${attempt}/${MAX_ATTEMPTS} failed with status ${status} (${reason})."

    if [[ "$reason" == 'feed-update' ]]; then
      rm -f "$attempt_log"
      fail_stage "$reason" "$feed" "$attempt" "$uri"
    fi

    if ((attempt == MAX_ATTEMPTS)); then
      rm -f "$attempt_log"
      fail_stage "$reason" "$feed" "$attempt" "$uri"
    fi

    if ((attempt == 1)); then
      mirror_uri="$(mirror_uri_for "$uri" || true)"
      if [[ -n "$mirror_uri" && "$mirror_uri" != "$uri" ]]; then
        echo "Probe feeds: switching ${feed} to official OpenWrt GitHub mirror for retry."
        replace_feed_uri "$feed" "$mirror_uri"
        uri="$mirror_uri"
      fi
    fi

    rm -f "$attempt_log"
    delay=$((attempt * 10))
    echo "Probe feeds: retrying ${feed} in ${delay}s."
    sleep "$delay"
  done
done

echo 'Probe feeds: all feed updates completed; installing feed packages.'
set +e
./scripts/feeds install -a 2>&1 | tee -a "$PROBE_LOG"
install_status="${PIPESTATUS[0]}"
set -e
if ((install_status != 0)); then
  write_runtime_file 'failure' 'feed-install' ''
  write_output failure_reason 'feed-install'
  write_output failure_feed ''
  echo "ERROR: Probe feeds install failed with status ${install_status}." | tee -a "$PROBE_LOG"
  exit "$install_status"
fi

write_runtime_file 'success'
write_output failure_reason ''
write_output failure_feed ''
echo 'Probe feeds: update and install completed.'
