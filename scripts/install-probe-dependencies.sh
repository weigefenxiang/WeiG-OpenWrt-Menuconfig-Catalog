#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 weigefenxiang <weigefenxiang@gmail.com>
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

: "${PROBE_MODE:?PROBE_MODE is required}"
: "${PROBE_LOG:=probe.log}"

MAX_ATTEMPTS="${PROBE_APT_MAX_ATTEMPTS:-3}"
ATTEMPT_TIMEOUT_SECONDS="${PROBE_APT_ATTEMPT_TIMEOUT_SECONDS:-480}"
APT_IO_TIMEOUT_SECONDS="${PROBE_APT_IO_TIMEOUT_SECONDS:-30}"

if [[ ! "$MAX_ATTEMPTS" =~ ^[1-3]$ ]]; then
  echo "ERROR: PROBE_APT_MAX_ATTEMPTS must be 1, 2, or 3." | tee -a "$PROBE_LOG"
  exit 2
fi
if [[ ! "$ATTEMPT_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ || ! "$APT_IO_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: Probe apt timeout values must be positive integer seconds." | tee -a "$PROBE_LOG"
  exit 2
fi

APT_OPTIONS=(
  -qq
  -o "Acquire::Retries=3"
  -o "Acquire::http::Timeout=${APT_IO_TIMEOUT_SECONDS}"
  -o "Acquire::https::Timeout=${APT_IO_TIMEOUT_SECONDS}"
)

run_apt_once() {
  sudo -E timeout --signal=TERM --kill-after=30s "${ATTEMPT_TIMEOUT_SECONDS}s" \
    apt-get "${APT_OPTIONS[@]}" "$@"
}

recover_dpkg() {
  echo "Probe bootstrap: recovering interrupted dpkg state before retry." | tee -a "$PROBE_LOG"
  sudo -E timeout --signal=TERM --kill-after=15s 120s dpkg --configure -a 2>&1 | tee -a "$PROBE_LOG"
}

retry_apt() {
  local label="$1"
  shift
  local apt_command="${1:-}"
  local attempt status recovery_status delay

  for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
    echo "Probe bootstrap: ${label} attempt ${attempt}/${MAX_ATTEMPTS}." | tee -a "$PROBE_LOG"
    set +e
    run_apt_once "$@" 2>&1 | tee -a "$PROBE_LOG"
    status="${PIPESTATUS[0]}"
    set -e

    if ((status == 0)); then
      return 0
    fi
    if ((attempt == MAX_ATTEMPTS)); then
      echo "ERROR: ${label} failed after ${MAX_ATTEMPTS} attempt(s), last exit code ${status}." | tee -a "$PROBE_LOG"
      return "$status"
    fi

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

retry_apt "apt-get update" update

if [[ "$PROBE_MODE" == "config-resolve" ]]; then
  retry_apt "config-resolve build dependencies" install \
    build-essential flex bison gawk gettext git libncurses-dev python3 rsync unzip zlib1g-dev file wget
else
  retry_apt "build dependencies" install \
    build-essential clang flex bison g++ gawk gcc-multilib g++-multilib \
    gettext git libncurses5-dev libssl-dev python3 python3-setuptools rsync unzip zlib1g-dev file wget
fi

if [[ "$PROBE_MODE" == "boot-smoke" ]]; then
  retry_apt "boot-smoke QEMU dependency" install qemu-system-x86
fi
