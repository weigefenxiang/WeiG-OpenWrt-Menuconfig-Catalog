#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 weigefenxiang <weigefenxiang@gmail.com>
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

: "${PROBE_MODE:?PROBE_MODE is required}"
: "${PROBE_LOG:=probe.log}"

MAX_ATTEMPTS="${PROBE_APT_MAX_ATTEMPTS:-3}"
UPDATE_TIMEOUT_SECONDS="${PROBE_APT_UPDATE_TIMEOUT_SECONDS:-240}"
INSTALL_TIMEOUT_SECONDS="${PROBE_APT_INSTALL_TIMEOUT_SECONDS:-300}"
APT_IO_TIMEOUT_SECONDS="${PROBE_APT_IO_TIMEOUT_SECONDS:-30}"
ATTEMPT_LOG_TAIL_LINES=80

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

run_apt_once() {
  local timeout_seconds="$1"
  shift
  sudo -E timeout --signal=TERM --kill-after=30s "${timeout_seconds}s" \
    apt-get "${APT_OPTIONS[@]}" "$@"
}

recover_dpkg() {
  echo "Probe bootstrap: recovering interrupted dpkg state before retry." | tee -a "$PROBE_LOG"
  sudo -E timeout --signal=TERM --kill-after=15s 120s dpkg --configure -a 2>&1 | tee -a "$PROBE_LOG"
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
  local attempt status recovery_status delay attempt_log started_at finished_at elapsed

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
      recover_dpkg
      recovery_status=$?
      set -e
      if ((recovery_status != 0)); then
        echo "WARNING: dpkg recovery exited with ${recovery_status}; the next apt attempt will re-check package state." | tee -a "$PROBE_LOG"
      fi
    fi

    delay=$((attempt * 15))
    echo "Probe bootstrap: retrying ${label} in ${delay}s." | tee -a "$PROBE_LOG"
    sleep "$delay"
  done
}

retry_apt "apt-get update" "$UPDATE_TIMEOUT_SECONDS" update

if [[ "$PROBE_MODE" == "config-resolve" ]]; then
  retry_apt "config-resolve build dependencies" "$INSTALL_TIMEOUT_SECONDS" install \
    build-essential flex bison gawk gettext git libncurses-dev python3 rsync unzip zlib1g-dev file wget
else
  retry_apt "build dependencies" "$INSTALL_TIMEOUT_SECONDS" install \
    build-essential clang flex bison g++ gawk gcc-multilib g++-multilib \
    gettext git libncurses5-dev libssl-dev python3 python3-setuptools rsync unzip zlib1g-dev file wget
fi

if [[ "$PROBE_MODE" == "boot-smoke" ]]; then
  retry_apt "boot-smoke QEMU dependency" "$INSTALL_TIMEOUT_SECONDS" install qemu-system-x86
fi
