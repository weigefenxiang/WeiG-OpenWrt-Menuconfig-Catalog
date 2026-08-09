# Compatibility Evidence Rules

`compatibility.json` records only compatibility problems that upstream Catalog/Kconfig data cannot currently express and that real build evidence has confirmed. It is not a second dependency database. Symbol types, N/M/Y capabilities, display names, translations, dependencies, providers, conflicts, hashes, and timestamps remain Catalog-owned facts.

## Schema 2

The document allows only `schema` and `rules`. Each rule allows:

- `id`: stable ID. Use `OWN-xxxx` for ownership and `BLD-xxxx` for known build failures.
- `issue`: `file-ownership` or `build-failure`; it selects generic validation and copy only.
- `match`: `all-installed` requires every package to be `Y`; `all-selected` requires every package to be `M/Y`.
- `scope`: Source IDs mapped to exact branch-name arrays.
- `if`: optional additional Kconfig expression; do not duplicate dependency facts.
- `packages`: 1–16 real package IDs. The browser resolves symbols, legal states, and cascades through Catalog.
- `paths`: required only for `file-ownership`; confirmed absolute paths with duplicate ownership.
- `refs`: 1–8 short evidence references such as a GitHub Actions Run ID; never copy complete logs.

The browser uniformly calls `evaluateCompatibilityRules()`, `deriveCompatibilityPlans()`, and the single state executor `applyUserIntent()`. Rules cannot contain commands, patches, or package-specific execution logic. The build backend must not turn them into locks or configuration rewrites. Users may apply the recommendation, choose custom N/M/Y states, or force continuation after a second confirmation.

Readers accept legacy schema-1 `ownership` during migration; publishers always emit schema 2. Normalized JSON has a 512 KiB uncompressed limit. Split by Source or Source/Branch only through an explicit future schema migration when the limit becomes relevant; do not maintain empty parallel datasets.

## Registered rules

### OWN-0001

- Scope: ImmortalWrt `openwrt-25.12` with `USE_APK` satisfied.
- Trigger: `luci-app-openvpn-server=Y` and `openvpn-openssl=Y`.
- Problem: both packages own `/etc/config/openvpn`, causing an APK file-ownership collision.
- Evidence: GitHub Actions Run `31248199953`.
- Handling: generic Catalog intents compare the cascades of disabling either participant. Only a unique minimum-cost plan is recommended; the user may still force continuation.
- Removal: after upstream removes duplicate ownership, verify a real build and immediately narrow `scope` or remove the rule.

### BLD-0001

- Scope: ImmortalWrt `openwrt-25.12`.
- Trigger: `oscam=M/Y`.
- Problem: this branch builds OSCam with internally defaulted `WITH_EMU` and `WITH_SOFTCAM`, and the linker has confirmed missing `_binary_SoftCam_Key_start/end`. No current OpenWrt Kconfig symbol independently disables it.
- Evidence: GitHub Actions Run `31319173318`.
- Handling: the recommendation uses Catalog `applyUserIntent()` only to set the whole `oscam` package to `N`. Forcing continuation does not patch source and may still fail; retaining OSCam requires an upstream fix.
- Removal: after upstream fixes the link or exposes a usable Kconfig option, verify a real build before narrowing `scope` or deleting the rule.

The `OSCAM_S_CACHEEX` versus package-Makefile `CONFIG_OSCAM_CS_CACHEEX` naming mismatch is independent. Do not fold it into BLD-0001 without evidence that it causes an actual failure.

## Maintenance and publication

Verify an actual failure before adding a branch to `scope`; similar source layouts are insufficient. Remove or narrow rules promptly after upstream fixes them. Zombie rules are forbidden.

When only `compatibility.json` changes, the workflow reads the existing `index.json` and `compatibility.json.gz` from the selected data branch and reuses `build-index.mjs --compatibility-only`. Source/Branch assets and hashes remain unchanged, and identical content creates no commit. Generator, validator, workflow, or collection-policy changes still run the complete matrix.

中文：[COMPATIBILITY.md](COMPATIBILITY.md)
