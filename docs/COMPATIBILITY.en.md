# Compatibility Evidence Rules

`compatibility.json` records only compatibility facts that upstream Kconfig/Catalog cannot currently express and real builds have confirmed. It is not a second dependency database and does not store symbol types, N/M/Y, names, translations, dependencies, providers, hashes, or timestamps.

## Schema 2

Publishers and readers accept schema 2 only. The document has `schema` and `rules`; each rule has:

- `id`: stable ID. Use `OWN-xxxx` for ownership and `BLD-xxxx` for known build failures.
- `issue`: `file-ownership` or `build-failure`.
- `match`: `all-installed` means every package is Y; `all-selected` means every package is M/Y.
- `scope`: Source to Branch-pattern arrays. Source can be named or a standalone `*`; Branch supports exact names and globs. Wildcard Source cannot mix with named Sources.
- `if`: optional Kconfig condition; never duplicate existing dependencies.
- `packages`: 1–16 real package IDs. A known one-package failure uses one ID instead of a fake participant.
- `paths`: required only for `file-ownership`; confirmed absolute duplicate-owned paths.
- `refs`: 1–8 short evidence references such as `run:31319173318`, never full logs.

The only browser execution chain is:

```text
evaluateCompatibilityRules → deriveCompatibilityPlans → applyUserIntent
```

Rules cannot contain commands, patches, or package-specific executors. The build backend cannot turn them into locks or configuration rewrites. Users may apply the recommendation, choose N/M/Y, or force continuation after a second confirmation.

Normalized JSON is limited to 512 KiB uncompressed. Split by Source/Branch only through an explicit future schema migration when that limit becomes relevant; do not pre-create parallel datasets.

## Registered rules

### OWN-0001

- Scope: ImmortalWrt `openwrt-25.12` with `USE_APK` satisfied.
- Trigger: `luci-app-openvpn-server=Y` and `openvpn-openssl=Y`.
- Problem: both packages own `/etc/config/openvpn`, causing an APK ownership collision.
- Evidence: Runs `31248199953` and `31382153641`; both report `trying to overwrite etc/config/openvpn owned by openvpn-openssl`.
- Handling: generic Catalog intents compare the cascades of disabling each participant. Only a unique lowest-cost plan is recommended; force remains available.
- Removal: after upstream removes duplicate ownership and a real build confirms it, narrow scope or delete immediately.

### BLD-0001

- Scope: every ImmortalWrt and LEDE Branch: `ImmortalWrt:["*"]`, `lede:["*"]`.
- Trigger: `oscam=M/Y`.
- Problem: repeated real builds fail at link time with missing `_binary_SoftCam_Key_start/end`; current Kconfig exposes no symbol that independently disables the internal feature.
- Evidence: Runs `31319173318`, `31343335898`, `31343364994`, `31343384324`, and `31343420988`.
- Handling: the recommendation uses `applyUserIntent()` only to set `oscam` to N. Force does not patch source and may still fail.
- Removal: after one upstream range is fixed, confirm with a package probe and a real build before narrowing scope; delete after every covered range is fixed.

### BLD-0002

- Scope: ImmortalWrt `master`.
- Trigger: `luci-app-openvpn-server=M/Y`.
- Problem: the current Branch fails while compiling the `ovpn-dco` dependency at `tcp.c` against Linux 6.18. This is an upstream package-closure build failure, not the `/etc/config/openvpn` ownership collision.
- Evidence: Run `31382119111`.
- Handling: the recommendation uses generic `applyUserIntent()` only to set the package to N; force does not patch upstream source.
- Removal: delete after an upstream fix passes both a package probe and a real build.

## Maintenance, probes, and publication

Inspect upstream source and real evidence before adding a rule, then audit the same Source/Branch mechanism horizontally. A future Branch already covered by a glob needs no JSON row, but its first real probe should still be recorded. Narrow rules promptly after fixes; zombie rules are forbidden.

Catalog's manual **Package Compatibility Probe** accepts 1–8 Catalog application or package IDs, Source/Branch globs, and `compile` or `co-install`. The controller reads `index.json`, `applications.json.gz`, and each matched Branch's `core` shard from the data branch paired with the current code channel. Catalog supplies a legal Target/Profile (x86/64 when available, otherwise the first buildable path), then the controller builds one dynamic Matrix. Each item compiles only the selected package closure rather than a firmware image; `co-install` also runs `package/install` to expose co-install and ownership failures. The Matrix is capped at 256 jobs. The repository owner can set `0` to use every planned job concurrently, other write collaborators are capped at 3, and ordinary visitors cannot manually run it in this repository. Run Summary is public; normalized evidence is retained for 60 days and complete logs for 30 days. Dry-run defaults to true.

Source/Branch combinations come exclusively from the Catalog index. Future `openwrt-*` branches under `ImmortalWrt`, `OpenWrt`, or `lede` naturally join the next complete probe after discovery; the probe keeps no version list. Evidence is review input and never mutates `compatibility.json` automatically.

The hard order for a new plugin or rule is: reuse existing Catalog data, audit the same data type/execution path/risk class, run the package probe first, and only then maintain a generic rule from real evidence. AutoBuild must not contain package names or dedicated executors.

When only `compatibility.json` changes, the Workflow sparse-checks out `index.json` and `compatibility.json.gz` and runs `build-index.mjs --compatibility-only`, without the Source/Branch matrix. A `curated-sizes.json`-only change similarly runs `--applications-only` for `applications.json.gz`. Generator, Source-policy, or Workflow changes still run the complete matrix.

Chinese and English rule documentation must remain synchronized. 中文：[COMPATIBILITY.md](COMPATIBILITY.md)
