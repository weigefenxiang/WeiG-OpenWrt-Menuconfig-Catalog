#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 weigefenxiang <weigefenxiang@gmail.com>
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

upstream="${1:?upstream directory is required}"
mapfile -t images < <(find "$upstream/bin/targets" -type f \( -name '*combined*.img' -o -name '*combined*.img.gz' \) | sort)
if (( ${#images[@]} == 0 )); then
  echo 'ERROR: no generic combined image is available for Boot smoke / 启动自检'
  exit 2
fi

image=""
for candidate in "${images[@]}"; do
  if [[ "$candidate" != *-efi.* && "$candidate" != *.vhdx* ]]; then image="$candidate"; break; fi
done
image="${image:-${images[0]}}"
raw="$image"
if [[ "$image" == *.gz ]]; then
  raw="${RUNNER_TEMP:-/tmp}/weige-probe-boot.img"
  gzip -dc "$image" > "$raw"
fi

boot_log="${GITHUB_WORKSPACE:-.}/boot-smoke.log"
set +e
timeout 180 qemu-system-x86_64 -nographic -no-reboot -m 512 \
  -drive "file=$raw,format=raw,if=virtio" >"$boot_log" 2>&1
status=$?
set -e
cat "$boot_log"
if grep -Eqi 'procd:.*init complete|Please press Enter to activate this console|br-lan.*link becomes ready' "$boot_log"; then
  echo 'Boot smoke passed / 启动自检通过'
  exit 0
fi
echo "ERROR: Boot smoke did not reach a generic OpenWrt ready marker (qemu status=$status)"
exit 1
