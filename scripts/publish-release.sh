#!/usr/bin/env bash
set -euo pipefail

tag="menuconfig-catalog-complete"
target_sha="${CATALOG_RELEASE_TARGET_SHA:-$GITHUB_SHA}"
source_sha="${CATALOG_RELEASE_SOURCE_SHA:-}"
notes="All Catalog assets were promoted from a verified immutable candidate in run $GITHUB_RUN_ID."
[[ -z "$source_sha" ]] || notes="$notes Candidate: $source_sha."
shopt -s nullglob
assets=(dist/index.json dist/*.json.gz dist/*.translations.json)
filtered=()
for asset in "${assets[@]}"; do
  [[ "$asset" == "dist/compatibility.json.gz" ]] && continue
  filtered+=("$asset")
done
assets=("${filtered[@]}")
if (( ${#assets[@]} < 3 )); then
  echo "release asset validation failed: found ${#assets[@]} files"
  exit 1
fi

if gh release view "$tag" >/dev/null 2>&1; then
  gh release edit "$tag" \
    --target "$target_sha" \
    --title "Complete Menuconfig Catalog" \
    --notes "$notes"
  gh release upload "$tag" "${assets[@]}" --clobber
else
  gh release create "$tag" \
    --target "$target_sha" \
    --title "Complete Menuconfig Catalog" \
    --notes "$notes" \
    "${assets[@]}"
fi
