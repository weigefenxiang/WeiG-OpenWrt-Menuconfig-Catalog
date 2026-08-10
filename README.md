# WeiG OpenWrt Menuconfig Catalog

## Dynamic targets and 11-language translations / 动态目标与 11 语翻译

The catalog is the data authority for source branches, Target selectors and the complete
Kconfig menu tree. The web customizer does not keep source branches, targets or menu entries
in JavaScript.

Catalog 是源码分支、Target 动态选择器和完整 Kconfig 菜单树的数据权威；主网页不在
JavaScript 中写死分支、Target 或菜单项目。

- Canonical English comes from upstream `.targetinfo`, `.packageinfo` and `Config.in`.
- Curated application titles and descriptions in all 11 languages come from
  `translations/zh-CN.json`; the filename is retained for compatibility.
- Main menu/category labels for all 11 UI languages come from `translations/menu-i18n.json`.
- The visible menu and the complete symbol table are separate: no-prompt/hidden Kconfig symbols remain out of the normal tree but are published for Advanced search and validation.
- Runtime relations use `relations.schema=3`: array records, string/expression pools, bit flags and integer adjacency lists retain every non-Target Kconfig symbol plus packageinfo-only packages without repeating object keys and symbol strings. A schema-2 readable graph is generated only for explicit diagnostics.
- Options carry `depends on`, `visible if`, `select`, `imply`, defaults, ranges and parent paths.
- Repeated Kconfig definitions are merged by symbol. Only explicit, incompatible types are hard conflicts; split declarations such as `tristate` in one file and `prompt` in another are legal and retained as one option.
- Package options also carry upstream `.packageinfo` `Conflicts:` metadata, so consumers can reject impossible `y/y` package combinations before compiling.
- Target selectors are emitted as an ordered schema and tree. Empty trailing selectors are hidden,
  one-option selectors are auto-selected, and extra future selectors can be appended without HTML changes.
- Every generation writes a `*.translations.json` coverage report.
- Catalog schema 6 splits each branch into `core`, `graph`, `menu`, `hidden`, `help`, and per-language menu gzip assets. The published index records every shard's compressed byte count, SHA-256, and immutable `assetRef` Git commit. Consumers initially fetch only `core + graph`; Advanced menu text and long help are loaded on demand. The schema-5 monolithic gzip remains temporarily as a compatibility fallback.
- Confirmed facts that upstream Kconfig cannot express live in the small global `compatibility.json`; it references package IDs only and never duplicates symbols, states, names, dependencies, or hashes. See [中文规则说明](docs/COMPATIBILITY.md) and [English rules](docs/COMPATIBILITY.en.md).
- The daily translation workflow reads branch assets from `index.json`, reuses `i18n-cache.json`, and translates only new or changed descriptions.
  Argos runs locally by default without a key; Azure is an explicit optional engine. Successful
  translations are published even when a batch is incomplete; remaining descriptions are kept in
  `translation-retry-queue.json` and retried first on the next run. A translation job is limited to
  60 minutes, with a shared 50-minute translation budget and at most 5000 descriptions per run.
- Curated application names/usages are joined by every known source package symbol. Text that
  should remain a technical English name is left untranslated instead of showing a fake tooltip.

英文以各上游源码为准；精选 Applications 的 11 语名称与用途由 Catalog 维护，11 语菜单
分类维护在 `translations/menu-i18n.json`。每日翻译任务复用历史翻译缓存，只翻译新增或变化
文本；额度不足或服务异常时保留官方英文并写入待译统计与重试队列，已完成部分仍可提交。
软件包选项也带有上游 `.packageinfo` 的 `Conflicts:` 元数据，使用方可在编译前拒绝不可能的 `y/y` 组合。
- 翻译任务每天上海时间 04:37 独立运行，不因普通 Push 或 Catalog 发布重复启动。
  自动与手动任务默认 `500×5` 批；手动任务可选择代码分支与 `catalog-data/catalog-dev/catalog-staging/catalog-fix` 数据通道，并可设置每批
  `100–5000` 条、`1–20` 批，但单次总数最多 5000 条。任务上限 60 分钟，全部批次共享
  50 分钟翻译预算；默认 `each-batch`，每个成功批次立即提交。`final` 可改为最后统一提交。
  取消、零结果或校验/发布失败不会提交当前批次；每周更新仍按文本指纹跳过未变化内容。

Refresh the curated application union manually after reviewing upstream application IDs and Chinese/English descriptions:

```bash
npm run refresh:curated
node scripts/collect-curated-size-samples.mjs size-samples
npm run refresh:sizes -- --samples size-samples --write
```

The curated list is deliberately manual; weekly Source/Branch discovery does not silently change UI IDs or translations. Official OPKG/APK index observations update `curated-sizes.json`, and the published `applications.json.gz` joins IDs, descriptions, and optional size bytes. The manual Package Compatibility Probe maps Catalog application IDs to packages and compiles selected closures in an index-driven Matrix without building firmware images.

为 WeiG OpenWrt 在线定制器生成静态 menuconfig 目录。项目本身不编译固件。

目录内容来自 ImmortalWrt、OpenWrt、Lean LEDE 与
`hanwckf/immortalwrt-mt798x` 各收录分支生成的 `tmp/.targetinfo`、
`tmp/.packageinfo` 和顶层 `Config.in` 树，包括：

- Source / Branch / Target System / Subtarget / Target Profile
- 顶层 `make menuconfig` 中可见的 bool、tristate、choice、string、int、hex，以及无 prompt 的隐藏 Kconfig 符号
- 可见菜单与完整符号集合分离；隐藏项不会污染普通菜单，但会进入 Advanced 搜索和配置验证
- `depends on`、`select`、`imply`、`default`、`range`、choice、provider、冲突、反向依赖与菜单路径
- `menu/endmenu` 显式层级，以及 `menuconfig` 通过正向 `if/depends` 形成的隐式父子层级
- 软件包 Kconfig 选项及其依赖关系

网页已经用动态 Target 选择器提供设备/Profile，因此目录不会重复发布 `Target Devices` 菜单和对应的数千个 Kconfig 项。普通菜单仅消费可见选项；完整关系表仍发布隐藏 Kconfig 与 packageinfo-only 软件包，使消费方可以通用处理语言包残留、依赖链、choice 和 provider，而无需在 `app.js` 中写包名特例。已有构建证据、但 Kconfig 无法表达的少量事实统一保存在根目录 `compatibility.json`；字段边界和维护规则见 [中文说明](docs/COMPATIBILITY.md) 与 [English](docs/COMPATIBILITY.en.md)。

## Schema 6 分片与体积报告

每个分支在迁移期同时发布旧单体和新分片：

- `*.core.json.gz`：Target/Profile、构建契约、来源与分片清单所需的最小启动数据。
- `*.graph.json.gz`：`relations.schema=3` 紧凑关系图；浏览器依赖解析只读取这一份关系数据。
- `*.menu.json.gz`：可见 Advanced 菜单的英文标题、短说明与路径。
- `*.hidden.json.gz`：隐藏 Kconfig/packageinfo-only 的搜索显示信息。
- `*.help.json.gz`：长 Help/usage，仅在用户查看完整说明时下载。
- `*.menu.<lang>.json.gz`：当前语言的菜单译文，不再一次加载全部语言。
- `*.relations.json.gz`：同一 schema-3 紧凑关系图，供离线工具和诊断使用；不再发布 40+ MB 的缩进 JSON。
- `*.relations.debug.json.gz`：仅在 `CATALOG_DEBUG_RELATIONS=true` 时生成的可读对象版，不进入正常网页运行数据。

生成后的 `*.meta.json` 包含 `sizeReport`，记录旧单体、首次 `core + graph`、全部分片、可读 Relations 与紧凑 Relations 的字节数。汇总命令：

```bash
npm run size-report -- dist
```

紧凑格式只删除重复表示，不删除 `depends/select/imply/choice/conflicts/provides`、隐藏节点或 packageinfo-only 语义。测试会先展开 schema 3，再与原关系图逐项比对。

## 自动更新

`.github/workflows/catalog.yml` 每周按 include/exclude pattern 自动发现远程分支；OpenWrt 覆盖 `main` 与 `openwrt-*`，ImmortalWrt 与 LEDE 覆盖 `master` 与 `openwrt-*`，未来版本无需人工加表；
hanwckf 仍只收录 `openwrt-21.02` 兼容分支。每个分支独立生成，
失败时沿用同一通道的上一次成功数据。`main` 发布到 `catalog-data`，`staging` 发布到
`catalog-staging`，`dev` 发布到 `catalog-dev`，`fix/*` 发布到 `catalog-fix`；每次先提交数据，
再用第二个提交把 `index.json` 的 `assetRef` 固定到前一个不可变数据提交。主站从 jsDelivr
或 GitHub Raw 整组读取 index 与该提交中的 gzip 分片，不在 VPS 保存 Catalog。

所有数据分支直接保存同名 `compatibility.json.gz`。只有 `main` 更新正式 Release；预览通道不创建 Release 或 Pages 地址。

- 矩阵不限制 `max-parallel`，由 GitHub 按账户并发额度调度。
- 自动翻译只新增软件包/菜单用途说明，技术名称与符号保持官方英文。脚本严格按 `index.json` 枚举旧单体和 schema 6 `menu:<lang>` 分片，并同步更新两者；不会扫描或改写 `core/graph/applications/compatibility`。简体中文说明未完成时，
  每日任务持续处理 `zh-CN`；完成后按 `ru → es → pt → ja → ko → de → fr → vi`
  每日轮转一种语言。英文是源文本，繁体中文暂时冻结，不进入自动轮转。
- 历史译文按“文本类型 + 英文正文”指纹复用；Push 触发只更新目录，不消耗翻译额度或推进
  轮转。默认每次最多请求 400,000 个源字符、每月最多记录 1,900,000 个字符；可通过
  Variables 的 `TRANSLATE_MONTHLY_BUDGET` 调整月预算，手动运行时也可调整单次预算和语言。
- 自动翻译默认使用无需密钥的本地 Argos。Azure 是可选引擎：使用时在仓库 Secrets 设置
  `AZURE_TRANSLATOR_KEY`，按资源需要设置 `AZURE_TRANSLATOR_REGION`，自定义端点可放在
  Variables 的 `AZURE_TRANSLATOR_ENDPOINT`。失败只写覆盖统计和错误，不阻断目录发布。
- Discover、每个矩阵 Job、Publish 依次使用 `01`、`02`… 编号；Job、
  Artifact、`SUMMARY`、attempt 和失败日志共用同一编号。Actions Summary
  另列一一对应表，按编号即可找到同一任务的全部资料。
- 每个分支独立校验 catalog、meta、translations、gzip 和 SHA-256；一个分支损坏只隔离该分支，不阻断其他成功分支发布。
- 成功阶段只输出名称和耗时；失败阶段在控制台显示关键错误及末尾 80 行，
  完整错误日志放入该分支唯一的结果 Artifact，保留 60 天。
- 本次失败或校验损坏但曾成功的分支沿用 `catalog-data` 中的 last-good 并标为
  `stale`；从未成功的分支标为 `unavailable`，不会伪装成最新数据。
- 只有全部分支成功时才更新固定 Release `menuconfig-catalog-complete`；
  部分失败只更新滚动目录，Workflow 保持失败状态。
- Publish 会逐个读取下载后的 Artifact 目录，核对成功分支的 catalog、
  meta、translations、attempt、SUMMARY、gzip 和 SHA-256；无效的“成功”结果进入隔离诊断，
  不得覆盖旧数据。`publish-inputs.json` 会逐分支记录 fresh/last-good/unavailable。
  固定 Release 存在时原位覆盖，不会先删除旧 Release。Publish 成败都会
  上传独立诊断 Artifact，记录输入清单、失败阶段和对应编号。

## Diagnostic identity and legacy metadata / 诊断身份与旧版元数据

Every matrix job and downloaded diagnostic file identifies its source, repository, branch,
display version, upstream commit, stage, run ID/attempt, job index, artifact and run URL.
Failure logs use unique names such as
`07-openwrt-openwrt-18.06--defconfig.log`; the same artifact also contains a readable
`--SUMMARY.txt` and a machine-readable `.attempt.json`. Full failure logs are retained for
60 days, while the Actions console shows only key errors and the last 40 relevant lines.

每个矩阵任务、错误日志和汇总文件都会写明源码、仓库、分支版本、上游提交、
失败阶段、Run ID/次数、任务序号、Artifact 名称和 Run 链接。日志文件名全局唯一，
不会再因多个分支都叫 `defconfig.log` 而互相覆盖；控制台只展示重点和末尾 80 行，完整错误日志保留 60 天。

Every Source/Branch uses one `metadata-only` boundary. Catalog extraction needs Kconfig/Perl
metadata but never compiles host tools or firmware, so it creates a fresh prerequisite cookie
before `make prepare-tmpinfo FORCE=1`. The rule is capability-based rather than a Source or
Branch allowlist, and therefore also covers future branches that retain obsolete Python/GCC
host checks.

所有 Source/Branch 统一使用 `metadata-only` 边界：Catalog 只提取 Kconfig/Perl
元数据，不编译主机工具或固件，因此在 `make prepare-tmpinfo FORCE=1` 前创建全新的
先决条件标记。该机制不按 Source/Branch 特判，也能自动覆盖仍保留旧 Python/GCC
主机检查的未来分支。

## 本地检查

```bash
npm test
```

真实目录生成需要 Linux 和 OpenWrt 构建依赖，由 GitHub Actions 完成：

```bash
node scripts/generate-catalog.mjs \
  --source-id OpenWrt \
  --repo openwrt/openwrt \
  --branch main \
  --tree /path/to/openwrt \
  --out dist
```

本项目保留上游英文原文，并维护 11 语菜单、常用插件用途、增量翻译缓存与覆盖报告；
未翻译或应保持原名的技术文本统一回退官方英文。

## Schema 6 runtime assets and the legacy build contract

During the migration window each branch publishes two independent contracts in `index.json`:

- `assets`: Schema 6 browser shards such as `core`, `graph`, and lazy menu/help assets;
- `legacy`: the exact Schema 5 / Relations 2 single bundle used by AutoBuild Actions validation.

The `legacy` object contains `asset`, compressed `hash`, compressed `bytes`, `catalogSchema`, and `relationsSchema`. Root-level `asset/hash/bytes` remain mirrored temporarily for older clients. New consumers must use `branch.legacy` as one atomic build contract and must not combine its file metadata with schemas from the split runtime model.
