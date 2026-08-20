#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 weigefenxiang <weigefenxiang@gmail.com>
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

ACTION="${1:-activate}"
WORKDIR="${PROBE_WORKDIR:-work/upstream}"
PREREQ_FILE="${WORKDIR}/include/prereq-build.mk"
PYTHON2_VERSION="2.7.18"
PYTHON2_SHA256="b62c0e7937551d0cc02b8fd5cb0f544f9405bafc9a54d3808ed4594812edef43"
PYTHON2_URL="https://www.python.org/ftp/python/${PYTHON2_VERSION}/Python-${PYTHON2_VERSION}.tar.xz"
RUNTIME_ROOT="${RUNNER_TEMP:-/tmp}/weige-probe-runtime"
PYTHON2_PREFIX="${RUNTIME_ROOT}/python-${PYTHON2_VERSION}"

[[ -f "$PREREQ_FILE" ]] || { echo "Probe runtime: upstream prerequisite contract is missing: $PREREQ_FILE" >&2; exit 1; }

write_output() {
  [[ -z "${GITHUB_OUTPUT:-}" ]] || printf '%s=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"
}

contract_block() {
  local name="$1"
  awk -v marker="SetupHostCommand,${name}," '
    index($0, marker) { active=1 }
    active { print }
    active && ($0 == "endef" || $0 ~ /\)\)[[:space:]]*$/) { exit }
  ' "$PREREQ_FILE"
}

python_candidate() {
  local block="$1" candidates candidate selected='' python_regex direct_distutils=false
  python_regex="$(printf '%s\n' "$block" | sed -nE "/^[[:space:]]*python3[[:space:]]+-V/ s/.*grep -E ['\"]([^'\"]+)['\"].*/\1/p" | head -n1)"
  if grep -Eq 'python3.*-c.*distutils' "$PREREQ_FILE"; then direct_distutils=true; fi
  if [[ -n "$python_regex" ]] && python3 -V 2>&1 | grep -Eq "$python_regex"; then
    if [[ "$direct_distutils" != true ]] || python3 -c 'import distutils' >/dev/null 2>&1; then
      printf '%s' system
      return
    fi
  fi
  candidates="$(printf '%s\n' "$block" | grep -oE 'python3\.[0-9]+' | cut -d. -f2 | sort -nu)"
  while read -r candidate; do
    [[ -n "$candidate" ]] || continue
    if [[ "$direct_distutils" == true && "$candidate" -gt 11 ]]; then continue; fi
    selected="$candidate"
  done <<<"$candidates"
  [[ -n "$selected" ]] || { echo 'Probe runtime: no supported Python candidate satisfies the upstream contract.' >&2; return 1; }
  printf '3.%s' "$selected"
}

detect_runtime() {
  local python_block gcc_block runtime python_version compiler gcc_regex
  python_block="$(contract_block python)"
  [[ -n "$python_block" ]] || { echo 'Probe runtime: upstream Python prerequisite contract is missing.' >&2; exit 1; }
  if grep -Eq '(^|[^A-Za-z0-9_])python2([^A-Za-z0-9_]|$)' <<<"$python_block" &&
     ! grep -Eq '(^|[^A-Za-z0-9_])python3([^A-Za-z0-9_]|$)' <<<"$python_block"; then
    runtime=python2
    python_version=2.7
  else
    runtime=python3
    python_version="$(python_candidate "$python_block")"
  fi

  compiler=system
  gcc_block="$(contract_block gcc)"
  gcc_regex="$(printf '%s\n' "$gcc_block" | sed -nE "s/.*grep -E ['\"]([^'\"]+)['\"].*/\1/p" | head -n1)"
  if [[ -n "$gcc_regex" ]] && ! gcc -dumpversion 2>&1 | grep -Eq "$gcc_regex"; then
    if gcc-10 -dumpversion 2>&1 | grep -Eq "$gcc_regex" || grep -Eq '(^|[^0-9])10([^0-9]|$)' <<<"$gcc_regex"; then
      compiler=gcc-10
    else
      echo "Probe runtime: no supported compiler candidate satisfies the upstream contract: $gcc_regex" >&2
      exit 1
    fi
  fi

  write_output runtime "$runtime"
  write_output python_version "$python_version"
  write_output compiler "$compiler"
  printf 'Probe runtime detected: runtime=%s python=%s compiler=%s\n' "$runtime" "$python_version" "$compiler"
}

install_gcc10() {
  if ! command -v gcc-10 >/dev/null || ! command -v g++-10 >/dev/null; then
    sudo -E timeout --signal=TERM --kill-after=30s 300s apt-get -y \
      -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install gcc-10 g++-10
  fi
  local compiler_bin="${RUNTIME_ROOT}/gcc10-bin"
  mkdir -p "$compiler_bin"
  ln -sfn "$(command -v gcc-10)" "${compiler_bin}/gcc"
  ln -sfn "$(command -v g++-10)" "${compiler_bin}/g++"
  export PATH="${compiler_bin}:${PATH}" CC=gcc-10 CXX=g++-10
  [[ -z "${GITHUB_PATH:-}" ]] || printf '%s\n' "$compiler_bin" >>"$GITHUB_PATH"
  [[ -z "${GITHUB_ENV:-}" ]] || printf '%s\n' 'CC=gcc-10' 'CXX=g++-10' >>"$GITHUB_ENV"
}

install_python2() {
  [[ -x "${PYTHON2_PREFIX}/bin/python2.7" ]] && return 0
  local build_root source_archive source_root
  mkdir -p "$RUNTIME_ROOT"
  build_root="$(mktemp -d "${RUNNER_TEMP:-/tmp}/weige-python2-build.XXXXXX")"
  source_archive="${build_root}/Python-${PYTHON2_VERSION}.tar.xz"
  source_root="${build_root}/Python-${PYTHON2_VERSION}"
  trap 'rm -rf "$build_root"' EXIT
  curl --fail --location --retry 3 --retry-delay 5 --retry-all-errors --connect-timeout 15 --max-time 180 \
    "$PYTHON2_URL" --output "$source_archive"
  printf '%s  %s\n' "$PYTHON2_SHA256" "$source_archive" | sha256sum --check --status
  tar -xJf "$source_archive" -C "$build_root"
  (cd "$source_root"; ./configure --prefix="$PYTHON2_PREFIX" --without-ensurepip >/dev/null; make -j2 >/dev/null; make install >/dev/null)
  rm -rf "$build_root"
  trap - EXIT
}

activate_runtime() {
  local runtime="${PROBE_RUNTIME_KIND:?PROBE_RUNTIME_KIND is required}"
  local compiler="${PROBE_COMPILER_KIND:?PROBE_COMPILER_KIND is required}"
  [[ "$compiler" != gcc-10 ]] || install_gcc10
  if [[ "$runtime" == python2 ]]; then
    install_python2
    export PATH="${PYTHON2_PREFIX}/bin:${PATH}"
    [[ -z "${GITHUB_PATH:-}" ]] || printf '%s\n' "${PYTHON2_PREFIX}/bin" >>"$GITHUB_PATH"
    version="$(${PYTHON2_PREFIX}/bin/python2.7 -V 2>&1)"
  else
    command -v python3 >/dev/null
    version="$(python3 -V 2>&1)"
  fi
  make -C "$WORKDIR" -j1 prereq
  write_output runtime "$runtime"
  write_output version "$version"
  write_output compiler "$compiler"
  printf 'Probe runtime active: %s; compiler=%s\n' "$version" "$compiler"
}

case "$ACTION" in
  detect) detect_runtime ;;
  activate) activate_runtime ;;
  *) echo "usage: $0 detect|activate" >&2; exit 2 ;;
esac
