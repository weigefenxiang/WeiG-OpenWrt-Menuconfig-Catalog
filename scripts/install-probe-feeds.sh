#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 weigefenxiang <weigefenxiang@gmail.com>
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

: "${PROBE_LOG:?PROBE_LOG is required}"

MAX_ATTEMPTS="${PROBE_FEED_MAX_ATTEMPTS:-3}"
MAX_PROVIDER_SWITCHES="${PROBE_FEED_MAX_PROVIDER_SWITCHES:-2}"
ATTEMPT_TIMEOUT_SECONDS="${PROBE_FEED_TIMEOUT_SECONDS:-180}"
BACKOFF_BASE_SECONDS="${PROBE_FEED_BACKOFF_BASE_SECONDS:-10}"
RUNTIME_FILE="${PROBE_FEEDS_RUNTIME:-${GITHUB_WORKSPACE:-$(pwd)}/probe-feeds-runtime.json}"

if [[ ! "$MAX_ATTEMPTS" =~ ^[1-3]$ ]]; then
  echo "ERROR: PROBE_FEED_MAX_ATTEMPTS must be 1, 2, or 3."
  exit 2
fi
if [[ ! "$MAX_PROVIDER_SWITCHES" =~ ^[0-2]$ ]]; then
  echo "ERROR: PROBE_FEED_MAX_PROVIDER_SWITCHES must be 0, 1, or 2."
  exit 2
fi
if [[ ! "$ATTEMPT_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: PROBE_FEED_TIMEOUT_SECONDS must be a positive integer."
  exit 2
fi
if [[ ! "$BACKOFF_BASE_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "ERROR: PROBE_FEED_BACKOFF_BASE_SECONDS must be a non-negative integer."
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
    'RPC failed|HTTP (408|425|429|5[0-9]{2})|returned error: (408|425|429|5[0-9]{2})|expected .?packfile|early EOF|empty reply|remote end hung up|Connection (timed out|reset|refused|closed|aborted)|Failed to connect|Couldn.t connect to server|Network is unreachable|No route to host|Temporary failure in name resolution|Name or service not known|Could not resolve host|Recv failure|Send failure|Operation timed out|unexpected disconnect|TLS.*(timeout|error|failed|terminated|reset)|GnuTLS.*(error|failed)|SSL.*(certificate|problem|error|failed|connect)|schannel.*(error|failed)' \
    "$file"
}

permanent_failure() {
  local file="$1"
  grep -Eqi \
    'HTTP (400|401|403|404|405|406|407|409|410|411|412|413|414|415|416|417|418|421|422|423|424|426|428|431|451)|returned error: (400|401|403|404|405|406|407|409|410|411|412|413|414|415|416|417|418|421|422|423|424|426|428|431|451)|authentication failed|authentication required|could not read Username|repository not found|access denied|permission denied|invalid credentials|does not appear to be a git repository|unknown revision|invalid ref|not found' \
    "$file"
}

provider_uris_for() {
  local uri="$1"
  local base suffix candidate
  local -a candidates=()
  base="${uri%%[;^]*}"
  suffix="${uri#"$base"}"

  case "$base" in
    https://git.openwrt.org/feed/packages.git|https://github.com/openwrt/packages.git|https://codeberg.org/openwrt/packages.git)
      candidates=(
        'https://git.openwrt.org/feed/packages.git'
        'https://github.com/openwrt/packages.git'
        'https://codeberg.org/openwrt/packages.git'
      )
      ;;
    https://git.openwrt.org/project/luci.git|https://github.com/openwrt/luci.git|https://codeberg.org/openwrt/luci.git)
      candidates=(
        'https://git.openwrt.org/project/luci.git'
        'https://github.com/openwrt/luci.git'
        'https://codeberg.org/openwrt/luci.git'
      )
      ;;
    https://git.openwrt.org/feed/routing.git|https://github.com/openwrt/routing.git|https://codeberg.org/openwrt/routing.git)
      candidates=(
        'https://git.openwrt.org/feed/routing.git'
        'https://github.com/openwrt/routing.git'
        'https://codeberg.org/openwrt/routing.git'
      )
      ;;
    https://git.openwrt.org/feed/telephony.git|https://github.com/openwrt/telephony.git|https://codeberg.org/openwrt/telephony.git)
      candidates=(
        'https://git.openwrt.org/feed/telephony.git'
        'https://github.com/openwrt/telephony.git'
        'https://codeberg.org/openwrt/telephony.git'
      )
      ;;
  esac

  printf '%s%s\n' "$base" "$suffix"
  for candidate in "${candidates[@]}"; do
    if [[ "$candidate" != "$base" ]]; then
      printf '%s%s\n' "$candidate" "$suffix"
    fi
  done
}

provider_for_uri() {
  local uri="$1"
  case "$uri" in
    https://git.openwrt.org/*) printf '%s' 'git.openwrt.org' ;;
    https://github.com/openwrt/*) printf '%s' 'github-openwrt' ;;
    https://codeberg.org/openwrt/*) printf '%s' 'codeberg-openwrt' ;;
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
  ./scripts/feeds list -sf | awk -v name="$feed" '$2 == name { print $3; exit }'
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

reset_feed_checkout() {
  local feed="$1"
  rm -rf "feeds/${feed}"
  rm -f "feeds/${feed}.index" "feeds/${feed}.targetindex"
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
  local failure_class="${4:-}"
  node - "$RUNTIME_ROWS" "$RUNTIME_FILE" "$outcome" "$failure_reason" "$failure_feed" "$failure_class" "${PROBE_SOURCE:-}" "${PROBE_BRANCH:-}" <<'NODE'
const fs = require('node:fs');
const [rowsFile, outputFile, outcome, failureReason, failureFeed, failureClass, source, branch] = process.argv.slice(2);
const rows = fs.existsSync(rowsFile) ? fs.readFileSync(rowsFile, 'utf8').trim().split(/\n/).filter(Boolean).map((line) => {
  const [name, status, provider, attempts, commit, url] = line.split('\t');
  return { name, status, provider, attempts: Number(attempts || 0), commit, url };
}) : [];
fs.writeFileSync(outputFile, `${JSON.stringify({ schema: 2, source, branch, outcome, failureReason, failureClass, failureFeed, feeds: rows }, null, 2)}\n`);
NODE
}

record_feed() {
  local feed="$1" status="$2" provider="$3" attempts="$4" commit="$5" uri="$6"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$feed" "$status" "$provider" "$attempts" "$commit" "$uri" >>"$RUNTIME_ROWS"
}

fail_stage() {
  local reason="$1" feed="$2" attempts="$3" uri="$4" failure_class="${5:-feed-fetch-infrastructure}"
  local provider
  provider="$(provider_for_uri "$uri")"
  record_feed "$feed" 'failure' "$provider" "$attempts" '' "$uri"
  write_runtime_file 'failure' "$reason" "$feed" "$failure_class"
  write_output failure_reason "$reason"
  write_output failure_class "$failure_class"
  write_output failure_feed "$feed"
  echo "ERROR: Probe feeds failed: class=${failure_class} reason=${reason} feed=${feed} total_attempts=${attempts} provider=${provider}." | tee -a "$PROBE_LOG"
  exit 1
}

ensure_runtime_feeds_config
mapfile -t FEEDS < <(./scripts/feeds list -n)
if ((${#FEEDS[@]} == 0)); then
  write_runtime_file 'failure' 'feed-config' '' 'feed-fetch-permanent'
  write_output failure_reason 'feed-config'
  write_output failure_class 'feed-fetch-permanent'
  write_output failure_feed ''
  echo 'ERROR: no feeds were declared by the upstream source.'
  exit 2
fi

for feed in "${FEEDS[@]}"; do
  original_uri="$(feed_uri "$feed")"
  if [[ -z "$original_uri" ]]; then
    fail_stage 'feed-config' "$feed" 0 '' 'feed-fetch-permanent'
  fi

  mapfile -t provider_uris < <(provider_uris_for "$original_uri")
  max_providers=$((MAX_PROVIDER_SWITCHES + 1))
  if ((${#provider_uris[@]} > max_providers)); then
    provider_uris=("${provider_uris[@]:0:max_providers}")
  fi
  provider_count="${#provider_uris[@]}"
  total_attempts=0
  feed_succeeded=false
  last_reason='feed-update'
  uri="$original_uri"

  for ((provider_index = 0; provider_index < provider_count; provider_index++)); do
    uri="${provider_uris[$provider_index]}"
    provider="$(provider_for_uri "$uri")"
    provider_number=$((provider_index + 1))

    if ((provider_index > 0)); then
      previous_provider="$(provider_for_uri "${provider_uris[$((provider_index - 1))]}")"
      echo "Probe feeds: switching ${feed} provider ${provider_index}/${provider_count} ${previous_provider} -> ${provider_number}/${provider_count} ${provider}."
      replace_feed_uri "$feed" "$uri"
      reset_feed_checkout "$feed"
    fi

    for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
      total_attempts=$((total_attempts + 1))
      attempt_log="$(mktemp)"
      echo "Probe feeds: updating ${feed} provider ${provider_number}/${provider_count} ${provider} attempt ${attempt}/${MAX_ATTEMPTS}."

      set +e
      timeout --signal=TERM --kill-after=20s "${ATTEMPT_TIMEOUT_SECONDS}s" ./scripts/feeds update "$feed" 2>&1 | tee -a "$PROBE_LOG" "$attempt_log"
      status="${PIPESTATUS[0]}"
      set -e

      if ((status == 0)); then
        commit="$(git -C "feeds/${feed}" rev-parse HEAD 2>/dev/null || true)"
        record_feed "$feed" 'success' "$provider" "$total_attempts" "$commit" "$uri"
        rm -f "$attempt_log"
        feed_succeeded=true
        break 2
      fi

      if ((status == 124 || status == 137)); then
        last_reason='feed-timeout'
        retryable=true
      elif network_failure "$attempt_log"; then
        last_reason='feed-network'
        retryable=true
      elif permanent_failure "$attempt_log"; then
        last_reason='feed-permanent'
        retryable=false
      else
        last_reason='feed-update'
        retryable=false
      fi

      echo "Probe feeds: ${feed} provider ${provider_number}/${provider_count} ${provider} attempt ${attempt}/${MAX_ATTEMPTS} failed with status ${status} (${last_reason})."
      rm -f "$attempt_log"

      if [[ "${retryable:-false}" != true ]]; then
        echo "Probe feeds: ${feed} failure is not retryable; stopping without another attempt or provider switch."
        fail_stage "$last_reason" "$feed" "$total_attempts" "$uri" 'feed-fetch-permanent'
      fi

      if ((attempt < MAX_ATTEMPTS)); then
        delay=$((BACKOFF_BASE_SECONDS * (1 << (attempt - 1))))
        echo "Probe feeds: retrying ${feed} on ${provider} in ${delay}s (exponential backoff)."
        if ((delay > 0)); then sleep "$delay"; fi
      fi
    done

    if ((provider_number < provider_count)); then
      echo "Probe feeds: ${feed} provider ${provider_number}/${provider_count} ${provider} exhausted after ${MAX_ATTEMPTS} attempts; changing source."
    fi
  done

  if [[ "$feed_succeeded" != true ]]; then
    echo "Probe feeds: ${feed} exhausted ${provider_count} provider(s) after ${total_attempts} total attempts."
    reason="$last_reason"
    fail_stage "$reason" "$feed" "$total_attempts" "$uri" 'feed-fetch-infrastructure'
  fi
done

echo 'Probe feeds: all feed updates completed; installing feed packages.'
set +e
./scripts/feeds install -a 2>&1 | tee -a "$PROBE_LOG"
install_status="${PIPESTATUS[0]}"
set -e
if ((install_status != 0)); then
  write_runtime_file 'failure' 'feed-install' '' 'feed-fetch-install'
  write_output failure_reason 'feed-install'
  write_output failure_class 'feed-fetch-install'
  write_output failure_feed ''
  echo "ERROR: Probe feeds install failed with status ${install_status}." | tee -a "$PROBE_LOG"
  exit "$install_status"
fi

write_runtime_file 'success'
write_output failure_class ''
write_output failure_reason ''
write_output failure_feed ''
echo 'Probe feeds: update and install completed.'
