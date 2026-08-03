#!/usr/bin/env bash
set -Eeuo pipefail

mode="${1:-native}"

if [[ "$mode" == "legacy-metadata" ]]; then
  # OpenWrt 18.06/19.07 unconditionally run obsolete host-version checks from
  # prepare-tmpinfo. Catalog generation needs Kconfig/Perl metadata only.
  mkdir -p staging_dir/host
  touch staging_dir/host/.prereq-build
  echo "Compatibility mode: metadata only; obsolete host-version gate bypassed."
fi

# Catalog only needs upstream target/package metadata. Do not resolve or rewrite
# an OpenWrt .config here; build requests provide their own complete config.
make prepare-tmpinfo FORCE=1
test -s tmp/.targetinfo
test -s tmp/.packageinfo
