#!/usr/bin/env bash
set -euo pipefail

tag="menuconfig-catalog-complete"
target_sha="${CATALOG_RELEASE_TARGET_SHA:-$GITHUB_SHA}"
source_sha="${CATALOG_RELEASE_SOURCE_SHA:-}"
notes="All Catalog assets were promoted from a verified immutable candidate in run $GITHUB_RUN_ID."
[[ -z "$source_sha" ]] || notes="$notes Candidate: $source_sha."

retry_max="${CATALOG_RELEASE_RETRY_MAX_ATTEMPTS:-4}"
retry_base="${CATALOG_RELEASE_RETRY_BASE_SECONDS:-15}"
[[ "$retry_max" =~ ^[1-9][0-9]*$ ]] && (( retry_max <= 10 )) || {
  echo "CATALOG_RELEASE_RETRY_MAX_ATTEMPTS must be an integer from 1 to 10" >&2
  exit 2
}
[[ "$retry_base" =~ ^[0-9]+$ ]] && (( retry_base <= 300 )) || {
  echo "CATALOG_RELEASE_RETRY_BASE_SECONDS must be an integer from 0 to 300" >&2
  exit 2
}

is_rate_limit_error() {
  grep -Eqi 'secondary rate limit|API rate limit exceeded|rate limit exceeded|HTTP (403|429).*rate|abuse detection'
}

RETRY_OUTPUT=""
run_gh_with_rate_limit_retry() {
  local attempt=1 status=0 delay=0
  RETRY_OUTPUT=""
  while true; do
    set +e
    RETRY_OUTPUT="$("$@" 2>&1)"
    status=$?
    set -e
    if (( status == 0 )); then
      [[ -z "$RETRY_OUTPUT" ]] || printf '%s\n' "$RETRY_OUTPUT"
      return 0
    fi
    printf '%s\n' "$RETRY_OUTPUT" >&2
    if ! is_rate_limit_error <<<"$RETRY_OUTPUT" || (( attempt >= retry_max )); then
      return "$status"
    fi
    delay=$(( retry_base * (2 ** (attempt - 1)) ))
    echo "GitHub rate limit detected; retrying in ${delay}s (attempt $((attempt + 1))/${retry_max})" >&2
    (( delay == 0 )) || sleep "$delay"
    attempt=$((attempt + 1))
  done
}

is_missing_release_error() {
  grep -Eqi 'release not found|HTTP 404|Not Found'
}

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

if run_gh_with_rate_limit_retry gh release view "$tag"; then
  run_gh_with_rate_limit_retry gh release edit "$tag" \
    --target "$target_sha" \
    --title "Complete Menuconfig Catalog" \
    --notes "$notes"
else
  view_status=$?
  if ! is_missing_release_error <<<"$RETRY_OUTPUT"; then
    exit "$view_status"
  fi
  run_gh_with_rate_limit_retry gh release create "$tag" \
    --target "$target_sha" \
    --title "Complete Menuconfig Catalog" \
    --notes "$notes"
fi

run_gh_with_rate_limit_retry gh release upload "$tag" "${assets[@]}" --clobber
