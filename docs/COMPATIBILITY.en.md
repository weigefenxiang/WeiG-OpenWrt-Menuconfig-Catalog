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

### Probe depth boundaries

Catalog's **Package Compatibility Probe / 软件包兼容探针** uses the Probe V3 contract and keeps configuration truth separate from build scheduling. Catalog Kconfig owns the Baseline, direct user Intent, and Final `PACKAGE_*` state. Once the run enters the exact upstream source tree, that Source's own Make system owns dependency scheduling, ordering, stamps, and incremental rebuilds.

- **L1 Package compile (`package-compile`)**: directly enabled packages in the current Probe session are Roots. The Runner reads upstream `tmp/.packageinfo` `Source-Makefile` records to map Binary Packages to real source build targets, deduplicates Roots produced by the same source, and enters the upstream dependency graph with one Make invocation. WeiG does not compile every Final dependency one by one and keeps no Binary→Source or dependency database. L1 does not run `package/install` or generate firmware.
- **L2 RootFS integration (`rootfs-integration`)**: complete L1, then run upstream `package/install` with the complete Final package state to expose APK/OPKG ownership, path-overwrite, and co-install conflicts.
- **L3 Firmware integration (`firmware-integration`)**: in the same Source/Branch/Target environment, first build the real Baseline captured when Probe opened, then build Final after the user's changes. A Baseline failure is only `inconclusive`; a package-introduced firmware failure requires Baseline success followed by Final failure.
- **L4 Boot smoke (`boot-smoke`)**: after a successful L3 Final firmware build, run generic QEMU startup-marker checks only on Catalog-approved bootable environments. This is neither a package-service runtime test nor a physical-hardware functional test.

`Defconfig` is orthogonal to L1-L4 and is an independent switch that defaults on. When enabled, the selected Source's own `make defconfig` runs and only directly enabled Probe Roots are required to retain their requested `m/y` state; automatic dependencies may be re-normalized upstream. When disabled, Probe does not proactively run `make defconfig`; L1 runs `prepare-tmpinfo` only to obtain upstream package metadata.

Probe V3 carries Baseline, direct `packageIntent`, the single authoritative Final `packageConfig`, Defconfig, five-dimensional environment constraints, and coverage controls. It does not transport a dependency list, build order, or a second packages/roots authority; the server derives Roots from validated direct Intent. Legacy `WEIG_PACKAGE_PROBE_STATE_V2` requests are rejected and must be resubmitted from the current AutoBuild page.

Environment scope is resolved dynamically from real Catalog structure. Each of **Source / Branch / Target System / Subtarget / Target Profile** can independently be wildcarded or constrained. Target System, Subtarget, and Profile come from structured Catalog core fields; Probe never reverse-parses strings such as `x86/64`. A wildcard stores a rule rather than today's leaf list, so newly discovered Branches, Targets, and Profiles naturally join the scope later. Impossible combinations are not applicable, not incompatible.

Coverage has two modes. **Auto** performs reproducible hierarchical maximum-coverage sampling within an administrator budget. If candidates fit the budget, all run; otherwise only dimensions left wildcarded by the user are diversified across Source, Branch, Target System, Subtarget, and Profile. The sampling seed is recorded as evidence and a later Run may rotate the sample. Defaults in `.github/automation-policy.json` are L1=200, L2=100, L3=30, and L4=10, with no batch above 256. **Exhaustive** covers every real candidate; scopes above 256 stay pinned to the first Catalog data commit and sampling seed and continue sequentially in batches of at most 256 instead of creating thousands of concurrent jobs.

Sampled and exhaustive conclusions are distinct. All-success or all-failure samples are only `sampled-compatible` or `sampled-incompatible`; `fully-compatible` and `fully-incompatible` require complete coverage. Mixed success/failure is `partially-compatible`. Downloads, disk exhaustion, Runner failures, unresolved metadata, Baseline failures, cancellation, and timeouts remain `inconclusive`. Evidence is grouped Source → Branch → Target System → Subtarget → Target Profile, which can localize a failure without automatically declaring an upstream bug or mutating `compatibility.json`.

The Issue gateway still treats the real Issue author and repository permission as authorization truth. It verifies the V3 state token, SHA-256, and Issue identity, then dispatches the matching code channel; continuation batches remain pinned to the first Catalog data commit. Owner/admin requests may use the administrator parallel budget, write/maintain collaborators remain capped at three concurrent jobs, and visitors cannot start the Matrix. The requester or a write/maintain/admin collaborator can reply with exactly `/cancel`; the cancellation marker stops the active Run and prevents future batches. Normalized evidence remains for 60 days and complete logs for 30 days.

Failure diagnosis follows upstream incremental build behavior. Expensive targets first use the Runner CPU count plus one; failures are reproduced against the **same upstream Root targets** with `-j1 V=s BUILD_LOG=1`, reusing the same work tree and stamps. The old Final-PACKAGE compile loop, fallback-Target loop, and `reduceFailureSet()` / `reductionMaxAttempts` no longer belong to Probe: WeiG does not split dependency closure or search for a synthetic minimum failing package set.

Code `main` and production data `catalog-data` retain independent lifecycles. Builder `main` writes only `catalog-candidate`, runtime/probe `main` reads `catalog-data`, and production data is promoted only by the manual Production Gate. Ordinary pushes, schedules, and Probe experiments cannot bypass that gate.

GitHub-hosted jobs still have platform time limits. Per-depth timeouts are declared in `.github/automation-policy.json`; a timeout yields only `inconclusive`, never package-failure evidence.

The hard order for a new plugin or rule is: reuse existing Catalog data, audit the same data type/execution path/risk class, run the package probe first, and only then maintain a generic rule from real evidence. AutoBuild must not contain package names or dedicated executors.

When only `compatibility.json` changes, the Workflow sparse-checks out `index.json` and `compatibility.json.gz` and runs `build-index.mjs --compatibility-only`, without the Source/Branch matrix. A `curated-sizes.json`-only change similarly runs `--applications-only` for `applications.json.gz`. Generator, Source-policy, or Workflow changes still run the complete matrix.

Chinese and English rule documentation must remain synchronized. 中文：[COMPATIBILITY.md](COMPATIBILITY.md)
