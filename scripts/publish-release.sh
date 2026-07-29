#!/usr/bin/env bash
set -euo pipefail

tag="menuconfig-catalog-complete"
shopt -s nullglob
assets=(dist/index.json dist/*.json.gz dist/*.translations.json)
if (( ${#assets[@]} < 3 )); then
  echo "release asset validation failed: found ${#assets[@]} files"
  exit 1
fi

if gh release view "$tag" >/dev/null 2>&1; then
  gh release edit "$tag" \
    --target "$GITHUB_SHA" \
    --title "Complete Menuconfig Catalog" \
    --notes "All discovered source branches completed successfully in run $GITHUB_RUN_ID."
  gh release upload "$tag" "${assets[@]}" --clobber
else
  gh release create "$tag" \
    --target "$GITHUB_SHA" \
    --title "Complete Menuconfig Catalog" \
    --notes "All discovered source branches completed successfully in run $GITHUB_RUN_ID." \
    "${assets[@]}"
fi
