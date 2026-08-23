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

Catalog's **Package Compatibility Probe / 软件包兼容探针** uses the Probe V3 contract and separates request truth from environment resolution. An Issue carries only direct `packageIntent` and its compact before/after `PACKAGE_*` projections. Catalog core supplies each environment's Target/Profile selectors. After cloning the exact upstream source, that Source's own Kconfig/Defconfig resolves dependencies and its Make system owns ordering, stamps, and incremental builds.

- **L1 Plugin (`config-resolve`)**: by default use the current source's official Kconfig/Defconfig resolver for the Final Root combination. When the optional A/B comparison is enabled, first unconditionally refresh the current Source/Branch metadata after Feeds installation, then preflight the direct plugin Root, solve the exclusion Baseline B and Final A, and retain one paired record per environment. If the Root is absent from that source/branch, record `skipped/root-absent-source`; both B and A are `not-run`, with no Target or compile stage. This proves configuration viability only and does not compile packages.
- **L2 Compile (`package-compile`)**: treat directly enabled packages as Roots, read upstream `tmp/.packageinfo` `Source-Makefile` records, deduplicate Roots produced by the same source, and enter the upstream dependency graph with one Make invocation. WeiG keeps no second Binary→Source or dependency database.
- **L3 Root system (`rootfs-integration`)**: reuse the same L2 result, then run upstream `prepare`, the complete selected `package/compile`, and `package/install` in order. The current Source Make graph produces Target, base-package, kernel-version, and package-manager prerequisites; WeiG does not assemble APK/OPKG state itself.
- **L4 Integration (`firmware-integration`)**: by default build one complete firmware from the user's Final configuration. With `comparison: { mode: "paired-exclusion", executionOrder: ["baseline", "final"] }`, the same environment Job first completes the corresponding depth with Baseline B (the selected direct plugin and automatic dependencies that Defconfig determines are no longer needed excluded), then reruns firmware, boot, and runtime stages with Final A.
- **L5 Boot (`boot-smoke`)**: after L4 succeeds, prefer the current source's own `scripts/qemustart` and require the Final firmware to reach basic userspace. No Target/QEMU parameter table is maintained.
- **L6 Runtime (`runtime-health`)**: after L5, use a reliable control channel to check init/procd, basic mounts, uptime, ubus when available, and Roots actually built into Final. When a serial console requires activation, activate it and wait for the root prompt before sending health commands. A missing reliable control channel is `skipped`.
- **L7 Reboot (`reboot-validation`)**: after L6, reboot Final normally, wait for a second boot, and repeat the same health checks. Real sysupgrade flashing is not performed.
- **L5-L7 firmware and virtual-boot adaptation**: after firmware completes, scan the actual artifacts under `bin/targets/<target>/<subtarget>/` and select bootable combined, EFI, rootfs, or kernel outputs by capability, never by an `openwrt-*` brand prefix. Stream `.gz` outputs through a bounded decompressor into a Probe-owned temporary directory. Pass real paths only through parser-verified official options supported by the current source's `scripts/qemustart`, such as `--rootfs` or `--kernel`; comments and usage text do not establish capability. Missing artifacts or path options are `skipped/virtual-boot-unsupported` with `deepestPassedLevel=L4`; a deterministic Baseline-B Guest boot failure is `blocked/base-profile-boot-failure`, while a Final-A Guest boot failure is `incompatible/final-boot-failed`; QEMU, permission, and host-resource failures are `unresolved`. The phase-aware result prevents a plugin-induced Final-A boot failure from being mislabeled as an upstream Base Profile blocker.

By default L2-L7 reuse completed Stages; they do not repeat builds merely to increase depth. With A/B enabled, B→A still shares the same Job's bootstrap, source, feeds, and incremental Make work tree, while each phase has separate logs and evidence. Before B, every A/B depth must unconditionally regenerate the current Source/Branch `tmp/.packageinfo` after Feeds installation; an existing file is stale-cache input and must never be reused. A refresh failure or a missing file after refresh is `metadata-unresolved/inconclusive` and keeps the Job failed. Preflight then parses only the refreshed metadata; it must not turn an empty Root set into a Target/RootFS/firmware build. A missing Root is `preflight-skipped`, so both B and A are `not-run` and the Summary does not say “Baseline B failed”. When Baseline B has no direct Root, record `baseline-ready/no-direct-roots`: do not compile a plugin or claim that every Base Profile package was built. A B `prepare` or shared-target failure short-circuits A; when deterministic evidence confirms a Base Profile/upstream fault, record `blocked`, mark the plugin `not-evaluated`, and never attribute it to the plugin. If B is only `skipped/virtual-boot-unsupported` because L5-L7 capability is unavailable, Final A still completes at least L4 and the paired result reports “firmware build passed, runtime not covered”; this is not a Base Profile blocker. Only when B succeeds and A fails, or an isolated B counterfactual replay succeeds while A fails, may the result be attributed to the plugin. A reruns the corresponding install/image/qemu stages at L3-L7. Every depth requires the selected Source's official resolver: L1 uses `scripts/config/conf`, while L2-L7 use `make defconfig`. A request cannot disable this step. Only direct Probe Roots must retain their requested `m/y` states; automatic dependencies such as `libatomic` and `libusb-1.0` exist only in each environment's resolved configuration and evidence, never in the Issue request.

Probe V3 carries direct `packageIntent`, compact `baselinePackageConfig`/`packageConfig` projections derived from that Intent, mandatory Defconfig, five-dimensional environment constraints, and coverage controls. The complete 836 Advanced menuconfig entries or 276 post-Defconfig entries are browser interaction state, not a Probe request. The Runner accepts no dependency list, build order, or second packages/roots authority. After validation, the server derives the compact Root configuration again for all L1-L7, so automatic dependencies carried by an older client do not become execution authority. Legacy `WEIG_PACKAGE_PROBE_STATE_V2` requests are rejected.

Each Probe Job clones the Catalog-pinned upstream commit first, then detects Python and GCC capability from that source's `include/prereq-build.mk`; Source/Branch names must not select the runtime. Generic Runner build dependencies cover the later package, RootFS, and firmware stages, while a compatibility runtime is installed only when the detected contract requires it. Upstream `make prepare-mk` then validates host prerequisites that do not depend on a Target/Profile `.config`. Evidence records direct Root count, package count after Defconfig, Python identity, and compiler identity separately.

Environment scope is resolved dynamically from real Catalog structure. Each of **Source / Branch / Target System / Subtarget / Target Profile** can independently be wildcarded or constrained. Target System, Subtarget, and Profile come from structured Catalog core fields; Probe never reverse-parses strings such as `x86/64`. A wildcard stores a rule rather than today's leaf list, so newly discovered Branches, Targets, and Profiles naturally join the scope later. Impossible combinations are not applicable, not incompatible.

Coverage has two modes. **Auto** performs reproducible hierarchical maximum-coverage sampling within an administrator budget. If candidates fit the budget, all run; otherwise only dimensions left wildcarded by the user are diversified across Source, Branch, Target System, Subtarget, and Profile. The sampling seed is recorded as evidence and a later Run may rotate the sample. Defaults in `.github/automation-policy.json` are L1=40, L2=200, L3=100, L4=30, and L5=10, with no batch above 256; L6/L7 require an explicit limit until real duration measurements exist. **Exhaustive** covers every real candidate; scopes above 256 stay pinned to the first Catalog data commit and sampling seed and continue sequentially in batches of at most 256 instead of creating thousands of concurrent jobs.

Sampled and exhaustive conclusions are distinct. All-success or all-failure samples are only `sampled-compatible` or `sampled-incompatible`; `fully-compatible` and `fully-incompatible` require complete coverage. Mixed success/failure is `partially-compatible`. Per-environment `compatible`, `incompatible`, `blocked`, and `skipped` are complete domain conclusions. `blocked` means a confirmed Base Profile/upstream shared-environment failure; the plugin was not evaluated and the row is excluded from the plugin-incompatibility rate. The Summary reports plugin incompatibility, Base Profile blocked, and execution `unresolved` separately. Downloads, disk exhaustion, Runner failures, unresolved metadata, cancellation, and timeouts remain `unresolved/inconclusive`; incomplete evidence keeps the Job failed. Evidence is grouped Source → Branch → Target System → Subtarget → Target Profile, which can localize a failure without automatically declaring an upstream bug or mutating `compatibility.json`.
Summary success rate is `compatible / (compatible + incompatible + blocked + unresolved)` with `skipped` excluded; evaluated compatibility is `compatible / (compatible + incompatible)`; evaluation coverage is `(compatible + incompatible) / applicable`; plugin-cause rate is plugin-caused incompatible rows divided by `incompatible`. Notes must explain all-compatible, all-incompatible, blocked, skipped, unresolved, and L4-passed-but-L5-L7-uncovered scopes.

Execution status and compatibility conclusion are separate axes. `target-prerequisite-failure`, `package-compile-prerequisite-failure`, `rootfs-*-prerequisite-failure`, and `firmware-prerequisite-failure` retain the innermost failed target, generic cause, failure fingerprint, and deterministic error summary, for example `package/kernel/linux`, `kernel-prerequisite`, and `module .../crypto/geniv.ko is missing`. When the failed target is shared by B and A, replay it in an isolated Baseline-B environment: if B fails too, record `blocked`; if B succeeds and A fails, record plugin-induced `incompatible`. A direct Root or A-added dependency failure is respectively a direct/dependency plugin incompatibility. A replay that cannot be completed reliably is `unresolved` and must stay red. A blocked Baseline B explicitly records Final A as `not-run` and does not increase the plugin-caused rate. A failure refreshing metadata after Feeds installation must be recorded as a structured `metadata-unresolved` issue (`phase: preflight`), and Summary Notes must explicitly say “Feeds 后元数据刷新失败 / after-Feeds metadata refresh failed”; it is neither a missing-plugin skip nor a reportable green conclusion. Network, downloads, disk, OOM/Killed, Runner, timeout, missing metadata/evidence, and unattributed failures remain operational/unattributed `unresolved/inconclusive` and must stay red. Final compatibility conclusions read normalized evidence only; Job green/red is never a substitute for the evidence conclusion.
The older `reported inconclusive` prerequisite vocabulary remains accepted only for backward-compatible evidence validation; newly classified deterministic Base Profile failures are emitted as `blocked`, while operational/unattributed inconclusive evidence remains unresolved and red.

The Issue gateway still treats the real Issue author and repository permission as authorization truth. It verifies the V3 state token, SHA-256, and Issue identity, then dispatches the matching code channel; continuation batches remain pinned to the first Catalog data commit. Owner/admin requests may use the administrator parallel budget, write/maintain collaborators remain capped at three concurrent jobs, and visitors cannot start the Matrix. The requester or a write/maintain/admin collaborator can reply with exactly `/cancel`; the cancellation marker stops the active Run and prevents future batches. Normalized evidence remains for 60 days and complete logs for 30 days.

Failure diagnosis follows upstream incremental build behavior. Expensive targets first use the Runner CPU count plus one; failures are reproduced against the **same upstream Root targets** with `-j1 V=s BUILD_LOG=1`, reusing the same work tree and stamps. The old Final-PACKAGE compile loop, fallback-Target loop, and `reduceFailureSet()` / `reductionMaxAttempts` no longer belong to Probe: WeiG does not split dependency closure or search for a synthetic minimum failing package set.

Code `main` and production data `catalog-data` retain independent lifecycles. Builder `main` writes only `catalog-candidate`, runtime/probe `main` reads `catalog-data`, and production data is promoted only by the manual Production Gate. Ordinary pushes, schedules, and Probe experiments cannot bypass that gate.

GitHub-hosted jobs still have platform time limits. Per-depth timeouts are declared in `.github/automation-policy.json`; a timeout yields only `inconclusive`, never package-failure evidence.

The hard order for a new plugin or rule is: reuse existing Catalog data, audit the same data type/execution path/risk class, run the package probe first, and only then maintain a generic rule from real evidence. AutoBuild must not contain package names or dedicated executors.

When only `compatibility.json` changes, the Workflow sparse-checks out `index.json` and `compatibility.json.gz` and runs `build-index.mjs --compatibility-only`, without the Source/Branch matrix. A `curated-sizes.json`-only change similarly runs `--applications-only` for `applications.json.gz`. Generator, Source-policy, or Workflow changes still run the complete matrix.

Chinese and English rule documentation must remain synchronized. 中文：[COMPATIBILITY.md](COMPATIBILITY.md)
