#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 weigefenxiang <weigefenxiang@gmail.com>
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

: "${PROBE_MODE:?PROBE_MODE is required}"
: "${PROBE_LOG:=probe.log}"

MAX_ATTEMPTS="${PROBE_APT_MAX_ATTEMPTS:-3}"
UPDATE_TIMEOUT_SECONDS="${PROBE_APT_UPDATE_TIMEOUT_SECONDS:-60}"
INSTALL_TIMEOUT_SECONDS="${PROBE_APT_INSTALL_TIMEOUT_SECONDS:-300}"
APT_IO_TIMEOUT_SECONDS="${PROBE_APT_IO_TIMEOUT_SECONDS:-30}"
ATTEMPT_LOG_TAIL_LINES=80
APT_MIRROR_LIST_PATH="/etc/apt/apt-mirrors.txt"
UBUNTU_MIRROR_INDEX_URL="http://mirrors.ubuntu.com/mirrors.txt"

if [[ ! "$MAX_ATTEMPTS" =~ ^[1-3]$ ]]; then
  echo "ERROR: PROBE_APT_MAX_ATTEMPTS must be 1, 2, or 3." | tee -a "$PROBE_LOG"
  exit 2
fi
if [[ ! "$UPDATE_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ || ! "$INSTALL_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ || ! "$APT_IO_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: Probe apt timeout values must be positive integer seconds." | tee -a "$PROBE_LOG"
  exit 2
fi

APT_OPTIONS=(
  -y
  -o "Acquire::Retries=3"
  -o "Acquire::http::Timeout=${APT_IO_TIMEOUT_SECONDS}"
  -o "Acquire::https::Timeout=${APT_IO_TIMEOUT_SECONDS}"
)

BOOTSTRAP_STARTED_AT="$(date +%s)"
TIMING_SUMMARY_FILE="$(mktemp)"

timing_result_from_status() {
  local status="$1"
  if ((status == 0)); then
    printf '%s' 'ok'
  elif ((status == 124 || status == 137)); then
    printf '%s' 'timeout'
  else
    printf '%s' 'failure'
  fi
}

record_timing() {
  local stage="$1"
  local result="$2"
  local elapsed="$3"
  shift 3
  local details="$*"
  local machine="[TIMING] stage=${stage}"
  local summary_label="$stage"

  if [[ -n "$details" ]]; then
    machine+=" ${details}"
    summary_label+=" ${details}"
  fi
  machine+=" result=${result} elapsed=${elapsed}s"
  echo "$machine"
  printf '  %-52s %4ss  %s\n' "$summary_label" "$elapsed" "$result" >>"$TIMING_SUMMARY_FILE"
}

finish_timing() {
  local status="$1"
  local finished_at elapsed result
  trap - EXIT
  set +e
  finished_at="$(date +%s)"
  elapsed=$((finished_at - BOOTSTRAP_STARTED_AT))
  if ((status == 0)); then
    result='ok'
  else
    result='failure'
  fi
  record_timing 'bootstrap-total' "$result" "$elapsed" || true
  echo 'Probe bootstrap timing summary:' || true
  cat "$TIMING_SUMMARY_FILE" || true
  rm -f "$TIMING_SUMMARY_FILE" || true
  exit "$status"
}

trap 'finish_timing "$?"' EXIT

run_apt_once() {
  local timeout_seconds="$1"
  shift
  sudo -E timeout --signal=TERM --kill-after=30s "${timeout_seconds}s" \
    apt-get "${APT_OPTIONS[@]}" "$@"
}

recover_dpkg() {
  local previous_attempt="${1:-0}"
  local install_label="${2:-build-dependencies}"
  local timing_label="${install_label// /-}"
  local started_at finished_at elapsed status result

  echo "Probe bootstrap: recovering interrupted dpkg state before retry." | tee -a "$PROBE_LOG"
  started_at="$(date +%s)"
  if sudo -E timeout --signal=TERM --kill-after=15s 120s dpkg --configure -a 2>&1 | tee -a "$PROBE_LOG"; then
    status=0
  else
    status=$?
  fi
  finished_at="$(date +%s)"
  elapsed=$((finished_at - started_at))
  result="$(timing_result_from_status "$status")"
  record_timing 'dpkg-recovery' "$result" "$elapsed" "after-attempt=${previous_attempt} label=${timing_label}"
  return "$status"
}

uses_runner_ubuntu_mirror_list() {
  [[ -f "$APT_MIRROR_LIST_PATH" ]] &&
    grep -RqsF "mirror+file:${APT_MIRROR_LIST_PATH}" /etc/apt/sources.list /etc/apt/sources.list.d 2>/dev/null
}

write_direct_ubuntu_mirrors() {
  printf '%s\tpriority:1\n%s\tpriority:2\n' \
    'https://archive.ubuntu.com/ubuntu/' \
    'https://security.ubuntu.com/ubuntu/' | sudo tee "$APT_MIRROR_LIST_PATH" >/dev/null
}

prepare_initial_ubuntu_source() {
  local started_at finished_at elapsed
  started_at="$(date +%s)"
  if ! uses_runner_ubuntu_mirror_list; then
    echo "Probe bootstrap: GitHub Runner Ubuntu mirror list is unavailable; keeping the existing apt sources for the first update attempt." | tee -a "$PROBE_LOG"
    finished_at="$(date +%s)"
    elapsed=$((finished_at - started_at))
    record_timing 'mirror-switch' 'ok' "$elapsed" 'attempt=1 target=unchanged'
    return 0
  fi

  echo "Probe bootstrap: replacing the GitHub Runner Ubuntu mirror with direct archive/security sources before the first update attempt." | tee -a "$PROBE_LOG"
  write_direct_ubuntu_mirrors
  finished_at="$(date +%s)"
  elapsed=$((finished_at - started_at))
  record_timing 'mirror-switch' 'ok' "$elapsed" 'attempt=1 target=direct'
}

write_geo_ubuntu_mirrors() {
  local index_log status mirror_count
  index_log="$(mktemp)"
  set +e
  curl --fail --silent --show-error --location --connect-timeout 5 --max-time 15 \
    "$UBUNTU_MIRROR_INDEX_URL" >"$index_log"
  status=$?
  set -e
  if ((status != 0)); then
    echo "WARNING: Ubuntu mirror index request failed with exit code ${status}; using direct Ubuntu archive fallback." | tee -a "$PROBE_LOG"
    rm -f "$index_log"
    write_direct_ubuntu_mirrors
    return 0
  fi

  mirror_count="$(awk '/^https?:\/\/[^[:space:]]+\/?$/ { if (!seen[$0]++) count++ } END { print count + 0 }' "$index_log")"
  if ((mirror_count == 0)); then
    echo "WARNING: Ubuntu mirror index returned no usable mirrors; using direct Ubuntu archive fallback." | tee -a "$PROBE_LOG"
    rm -f "$index_log"
    write_direct_ubuntu_mirrors
    return 0
  fi

  {
    awk '/^https?:\/\/[^[:space:]]+\/?$/ { if (!seen[$0]++) print $0 "\tpriority:10" }' "$index_log"
    printf '%s\tpriority:100\n%s\tpriority:101\n' \
      'https://archive.ubuntu.com/ubuntu/' \
      'https://security.ubuntu.com/ubuntu/'
  } | sudo tee "$APT_MIRROR_LIST_PATH" >/dev/null
  rm -f "$index_log"
  echo "Probe bootstrap: loaded ${mirror_count} official geo Ubuntu mirror(s) with direct archive fallback." | tee -a "$PROBE_LOG"
}

prepare_update_retry_source() {
  local next_attempt="$1"
  local started_at finished_at elapsed target
  started_at="$(date +%s)"
  if ! uses_runner_ubuntu_mirror_list; then
    echo "WARNING: GitHub Runner Ubuntu mirror list is unavailable; keeping the existing apt sources for attempt ${next_attempt}/${MAX_ATTEMPTS}." | tee -a "$PROBE_LOG"
    finished_at="$(date +%s)"
    elapsed=$((finished_at - started_at))
    record_timing 'mirror-switch' 'ok' "$elapsed" "attempt=${next_attempt} target=unchanged"
    return 0
  fi

  if ((next_attempt == 2)); then
    target='geo'
    echo "Probe bootstrap: switching Ubuntu apt source to the official geo mirror index before attempt ${next_attempt}/${MAX_ATTEMPTS}." | tee -a "$PROBE_LOG"
    write_geo_ubuntu_mirrors
  else
    target='direct'
    echo "Probe bootstrap: switching Ubuntu apt source to direct archive/security fallback before attempt ${next_attempt}/${MAX_ATTEMPTS}." | tee -a "$PROBE_LOG"
    write_direct_ubuntu_mirrors
  fi
  finished_at="$(date +%s)"
  elapsed=$((finished_at - started_at))
  record_timing 'mirror-switch' 'ok' "$elapsed" "attempt=${next_attempt} target=${target}"
}

print_attempt_tail() {
  local label="$1"
  local attempt="$2"
  local attempt_log="$3"

  echo "Probe bootstrap: last ${ATTEMPT_LOG_TAIL_LINES} output lines for ${label} attempt ${attempt}/${MAX_ATTEMPTS}:"
  if [[ -s "$attempt_log" ]]; then
    tail -n "$ATTEMPT_LOG_TAIL_LINES" "$attempt_log"
  else
    echo "Probe bootstrap: no apt output was captured for this attempt."
  fi
}

retry_apt() {
  local label="$1"
  local timeout_seconds="$2"
  shift 2
  local apt_command="${1:-}"
  local timing_stage timing_label timing_result
  local attempt status recovery_status delay attempt_log started_at finished_at elapsed backoff_started_at backoff_finished_at backoff_elapsed

  if [[ "$apt_command" == "update" ]]; then
    timing_stage='apt-update'
  else
    timing_stage='apt-install'
  fi
  timing_label="${label// /-}"

  for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
    attempt_log="$(mktemp)"
    echo "Probe bootstrap: ${label} attempt ${attempt}/${MAX_ATTEMPTS} (timeout ${timeout_seconds}s)." | tee -a "$PROBE_LOG"
    started_at="$(date +%s)"
    set +e
    run_apt_once "$timeout_seconds" "$@" 2>&1 | tee -a "$PROBE_LOG" "$attempt_log"
    status="${PIPESTATUS[0]}"
    set -e
    finished_at="$(date +%s)"
    elapsed=$((finished_at - started_at))
    timing_result="$(timing_result_from_status "$status")"
    record_timing "$timing_stage" "$timing_result" "$elapsed" "attempt=${attempt} label=${timing_label}"

    if ((status == 0)); then
      echo "Probe bootstrap: ${label} attempt ${attempt}/${MAX_ATTEMPTS} completed in ${elapsed}s." | tee -a "$PROBE_LOG"
      rm -f "$attempt_log"
      return 0
    fi

    echo "Probe bootstrap: ${label} attempt ${attempt}/${MAX_ATTEMPTS} exited with ${status} after ${elapsed}s." | tee -a "$PROBE_LOG"
    if ((status == 124 || status == 137)); then
      echo "TIMEOUT: ${label} attempt ${attempt}/${MAX_ATTEMPTS} exceeded ${timeout_seconds}s; showing captured output."
    else
      echo "WARNING: ${label} attempt ${attempt}/${MAX_ATTEMPTS} failed with exit code ${status}; showing captured output."
    fi
    print_attempt_tail "$label" "$attempt" "$attempt_log"

    if ((attempt == MAX_ATTEMPTS)); then
      if ((status == 124 || status == 137)); then
        echo "ERROR: ${label} timed out after ${MAX_ATTEMPTS} attempt(s), ${timeout_seconds}s per attempt; last exit code ${status}." | tee -a "$PROBE_LOG"
      else
        echo "ERROR: ${label} failed after ${MAX_ATTEMPTS} attempt(s), last exit code ${status}." | tee -a "$PROBE_LOG"
      fi
      rm -f "$attempt_log"
      return "$status"
    fi
    rm -f "$attempt_log"

    if [[ "$apt_command" == "install" ]]; then
      set +e
      recover_dpkg "$attempt" "$label"
      recovery_status=$?
      set -e
      if ((recovery_status != 0)); then
        echo "WARNING: dpkg recovery exited with ${recovery_status}; the next apt attempt will re-check package state." | tee -a "$PROBE_LOG"
      fi
    elif [[ "$apt_command" == "update" ]]; then
      prepare_update_retry_source "$((attempt + 1))"
    fi

    delay=$((attempt * 15))
    echo "Probe bootstrap: retrying ${label} in ${delay}s." | tee -a "$PROBE_LOG"
    backoff_started_at="$(date +%s)"
    sleep "$delay"
    backoff_finished_at="$(date +%s)"
    backoff_elapsed=$((backoff_finished_at - backoff_started_at))
    record_timing 'backoff' 'ok' "$backoff_elapsed" "attempt=${attempt} label=${timing_label}"
  done
}

prepare_initial_ubuntu_source
retry_apt "apt-get update" "$UPDATE_TIMEOUT_SECONDS" update

if [[ "$PROBE_MODE" == "config-resolve" ]]; then
  retry_apt "config-resolve build dependencies" "$INSTALL_TIMEOUT_SECONDS" install \
    build-essential flex bison gawk gettext git libncurses-dev python3 rsync unzip zlib1g-dev file wget
else
  retry_apt "build dependencies" "$INSTALL_TIMEOUT_SECONDS" install \
    build-essential clang flex bison g++ gawk gcc-multilib g++-multilib \
    gettext git libncurses5-dev libssl-dev python3 python3-pyelftools python3-setuptools \
    rsync unzip zlib1g-dev file wget
fi

case "$PROBE_MODE" in
  boot-smoke|runtime-health|reboot-validation)
    retry_apt "virtual Probe QEMU dependency" "$INSTALL_TIMEOUT_SECONDS" install qemu-system-x86
    ;;
esac
