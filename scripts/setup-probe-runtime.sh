#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 weigefenxiang <weigefenxiang@gmail.com>
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

: "${PROBE_SOURCE:?PROBE_SOURCE is required}"
: "${PROBE_BRANCH:?PROBE_BRANCH is required}"

PYTHON2_VERSION="2.7.18"
PYTHON2_SHA256="b62c0e7937551d0cc02b8fd5cb0f544f9405bafc9a54d3808ed4594812edef43"
PYTHON2_URL="https://www.python.org/ftp/python/${PYTHON2_VERSION}/Python-${PYTHON2_VERSION}.tar.xz"
RUNTIME_ROOT="${RUNNER_TEMP:-/tmp}/weige-probe-runtime"
PYTHON2_PREFIX="${RUNTIME_ROOT}/python-${PYTHON2_VERSION}"

write_output() {
  local key="$1"
  local value="$2"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s=%s\n' "$key" "$value" >>"$GITHUB_OUTPUT"
  fi
}

runtime_for_source_branch() {
  case "${PROBE_SOURCE}/${PROBE_BRANCH}" in
    OpenWrt/openwrt-18.06|OpenWrt/openwrt-19.07)
      printf '%s' 'python2'
      ;;
    *)
      printf '%s' 'python3'
      ;;
  esac
}

requires_gcc10() {
  [[ "${PROBE_SOURCE}/${PROBE_BRANCH}" == 'OpenWrt/openwrt-18.06' ]]
}

install_gcc10() {
  if command -v gcc-10 >/dev/null && command -v g++-10 >/dev/null; then
    return 0
  fi
  echo "Probe runtime: installing Ubuntu gcc-10/g++-10 for ${PROBE_SOURCE}/${PROBE_BRANCH}."
  sudo -E timeout --signal=TERM --kill-after=30s 300s apt-get -y \
    -o Acquire::Retries=3 \
    -o Acquire::http::Timeout=30 \
    -o Acquire::https::Timeout=30 \
    install gcc-10 g++-10
}

activate_gcc10() {
  local legacy_bin="${RUNTIME_ROOT}/gcc10-bin"
  mkdir -p "$legacy_bin"
  ln -sfn "$(command -v gcc-10)" "${legacy_bin}/gcc"
  ln -sfn "$(command -v g++-10)" "${legacy_bin}/g++"
  export PATH="${legacy_bin}:${PATH}"
  export CC='gcc-10'
  export CXX='g++-10'
  if [[ -n "${GITHUB_PATH:-}" ]]; then
    printf '%s\n' "$legacy_bin" >>"$GITHUB_PATH"
  fi
  if [[ -n "${GITHUB_ENV:-}" ]]; then
    printf '%s\n' 'CC=gcc-10' 'CXX=g++-10' >>"$GITHUB_ENV"
  fi
  write_output compiler 'gcc-10'
}

install_python2() {
  local source_archive source_root build_root
  if [[ -x "${PYTHON2_PREFIX}/bin/python2.7" ]]; then
    return 0
  fi

  mkdir -p "$RUNTIME_ROOT"
  build_root="$(mktemp -d "${RUNNER_TEMP:-/tmp}/weige-python2-build.XXXXXX")"
  source_archive="${build_root}/Python-${PYTHON2_VERSION}.tar.xz"
  source_root="${build_root}/Python-${PYTHON2_VERSION}"

  trap 'rm -rf "$build_root"' EXIT

  echo "Probe runtime: installing Python ${PYTHON2_VERSION} for ${PROBE_SOURCE}/${PROBE_BRANCH} from python.org."
  curl --fail --location --retry 3 --retry-delay 5 --retry-all-errors \
    --connect-timeout 15 --max-time 180 \
    "$PYTHON2_URL" --output "$source_archive"
  printf '%s  %s\n' "$PYTHON2_SHA256" "$source_archive" | sha256sum --check --status

  tar -xJf "$source_archive" -C "$build_root"
  (
    cd "$source_root"
    ./configure --prefix="$PYTHON2_PREFIX" --without-ensurepip >/dev/null
    make -j2 >/dev/null
    make install >/dev/null
  )

  [[ -x "${PYTHON2_PREFIX}/bin/python2.7" ]]
  rm -rf "$build_root"
  trap - EXIT
}

runtime="$(runtime_for_source_branch)"
write_output runtime "$runtime"

if [[ "$runtime" == 'python2' ]]; then
  if requires_gcc10; then
    install_gcc10
    activate_gcc10
  else
    write_output compiler 'system'
  fi
  install_python2
  export PATH="${PYTHON2_PREFIX}/bin:${PATH}"
  if [[ -n "${GITHUB_PATH:-}" ]]; then
    printf '%s\n' "${PYTHON2_PREFIX}/bin" >>"$GITHUB_PATH"
  fi
  version="$(${PYTHON2_PREFIX}/bin/python2.7 -V 2>&1)"
  [[ "$version" == Python\ 2.7* ]]
  write_output version "$version"
  echo "Probe runtime: ${PROBE_SOURCE}/${PROBE_BRANCH} uses ${version}."
else
  write_output compiler 'system'
  command -v python3 >/dev/null
  version="$(python3 -V 2>&1)"
  [[ "$version" == Python\ 3* ]]
  write_output version "$version"
  echo "Probe runtime: ${PROBE_SOURCE}/${PROBE_BRANCH} uses ${version}."
fi
