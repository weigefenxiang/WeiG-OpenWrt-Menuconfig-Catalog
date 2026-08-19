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

Catalog's **Package Compatibility Probe / 软件包兼容探针** uses the Probe V3 contract and keeps configuration truth separate from build scheduling. Catalog Kconfig owns direct user Intent and the single Final `PACKAGE_*` state. Once the run enters the exact upstream source tree, that Source's own Make system owns dependency scheduling, ordering, stamps, and incremental rebuilds.

- **L1 Plugin (`config-resolve`)**: use the current source's official Kconfig/Defconfig resolver for the Final Root combination. This proves configuration viability only and does not compile packages.
- **L2 Compile (`package-compile`)**: treat directly enabled packages as Roots, read upstream `tmp/.packageinfo` `Source-Makefile` records, deduplicate Roots produced by the same source, and enter the upstream dependency graph with one Make invocation. WeiG keeps no second Binary→Source or dependency database.
- **L3 Root system (`rootfs-integration`)**: reuse the same L2 result, then run upstream `prepare`, the complete selected `package/compile`, and `package/install` in order. The current Source Make graph produces Target, base-package, kernel-version, and package-manager prerequisites; WeiG does not assemble APK/OPKG state itself.
- **L4 Integration (`firmware-integration`)**: build one complete firmware from the user's Final configuration. No Baseline is built, and a failure does not claim that one plugin caused a difference from Baseline.
- **L5 Boot (`boot-smoke`)**: after L4 succeeds, prefer the current source's own `scripts/qemustart` and require the Final firmware to reach basic userspace. No Target/QEMU parameter table is maintained.
- **L6 Runtime (`runtime-health`)**: after L5, use a reliable control channel to check init/procd, basic mounts, uptime, ubus when available, and Roots actually built into Final. A missing reliable control channel is `skipped`.
- **L7 Reboot (`reboot-validation`)**: after L6, reboot Final normally, wait for a second boot, and repeat the same health checks. Real sysupgrade flashing is not performed.

L2-L7 execute Final only and reuse completed Stages; they do not run Baseline/Final A/B or repeat builds merely to increase depth. Success means the Final configuration reached the selected depth in that environment. Failure describes that Final configuration and Stage without assigning independent causality to one plugin. L1 always uses the official resolver; L2-L7 default Defconfig on but allow an explicit request to disable it.

Probe V3 carries Baseline only to validate Intent's previous values, direct `packageIntent`, the single build-authoritative Final `packageConfig`, Defconfig, five-dimensional environment constraints, and coverage controls. The Runner does not build Baseline, nor does the request transport a dependency list, build order, or a second packages/roots authority; the server derives Roots from validated direct Intent. Legacy `WEIG_PACKAGE_PROBE_STATE_V2` requests are rejected and must be resubmitted from the current AutoBuild page.

Environment scope is resolved dynamically from real Catalog structure. Each of **Source / Branch / Target System / Subtarget / Target Profile** can independently be wildcarded or constrained. Target System, Subtarget, and Profile come from structured Catalog core fields; Probe never reverse-parses strings such as `x86/64`. A wildcard stores a rule rather than today's leaf list, so newly discovered Branches, Targets, and Profiles naturally join the scope later. Impossible combinations are not applicable, not incompatible.

Coverage has two modes. **Auto** performs reproducible hierarchical maximum-coverage sampling within an administrator budget. If candidates fit the budget, all run; otherwise only dimensions left wildcarded by the user are diversified across Source, Branch, Target System, Subtarget, and Profile. The sampling seed is recorded as evidence and a later Run may rotate the sample. Defaults in `.github/automation-policy.json` are L1=40, L2=200, L3=100, L4=30, and L5=10, with no batch above 256; L6/L7 require an explicit limit until real duration measurements exist. **Exhaustive** covers every real candidate; scopes above 256 stay pinned to the first Catalog data commit and sampling seed and continue sequentially in batches of at most 256 instead of creating thousands of concurrent jobs.

Sampled and exhaustive conclusions are distinct. All-success or all-failure samples are only `sampled-compatible` or `sampled-incompatible`; `fully-compatible` and `fully-incompatible` require complete coverage. Mixed success/failure is `partially-compatible`. Downloads, disk exhaustion, Runner failures, unresolved metadata, cancellation, and timeouts remain `inconclusive`. Evidence is grouped Source → Branch → Target System → Subtarget → Target Profile, which can localize a failure without automatically declaring an upstream bug or mutating `compatibility.json`.

The Issue gateway still treats the real Issue author and repository permission as authorization truth. It verifies the V3 state token, SHA-256, and Issue identity, then dispatches the matching code channel; continuation batches remain pinned to the first Catalog data commit. Owner/admin requests may use the administrator parallel budget, write/maintain collaborators remain capped at three concurrent jobs, and visitors cannot start the Matrix. The requester or a write/maintain/admin collaborator can reply with exactly `/cancel`; the cancellation marker stops the active Run and prevents future batches. Normalized evidence remains for 60 days and complete logs for 30 days.

Failure diagnosis follows upstream incremental build behavior. Expensive targets first use the Runner CPU count plus one; failures are reproduced against the **same upstream Root targets** with `-j1 V=s BUILD_LOG=1`, reusing the same work tree and stamps. The old Final-PACKAGE compile loop, fallback-Target loop, and `reduceFailureSet()` / `reductionMaxAttempts` no longer belong to Probe: WeiG does not split dependency closure or search for a synthetic minimum failing package set.

Code `main` and production data `catalog-data` retain independent lifecycles. Builder `main` writes only `catalog-candidate`, runtime/probe `main` reads `catalog-data`, and production data is promoted only by the manual Production Gate. Ordinary pushes, schedules, and Probe experiments cannot bypass that gate.

GitHub-hosted jobs still have platform time limits. Per-depth timeouts are declared in `.github/automation-policy.json`; a timeout yields only `inconclusive`, never package-failure evidence.

The hard order for a new plugin or rule is: reuse existing Catalog data, audit the same data type/execution path/risk class, run the package probe first, and only then maintain a generic rule from real evidence. AutoBuild must not contain package names or dedicated executors.

When only `compatibility.json` changes, the Workflow sparse-checks out `index.json` and `compatibility.json.gz` and runs `build-index.mjs --compatibility-only`, without the Source/Branch matrix. A `curated-sizes.json`-only change similarly runs `--applications-only` for `applications.json.gz`. Generator, Source-policy, or Workflow changes still run the complete matrix.

Chinese and English rule documentation must remain synchronized. 中文：[COMPATIBILITY.md](COMPATIBILITY.md)
