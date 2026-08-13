# Compatibility 证据规则

`compatibility.json` 只记录上游 Kconfig/Catalog 当前无法表达、但真实构建已经确认的兼容性事实。它不是第二套 dependency 数据库，不保存 symbol 类型、N/M/Y、名称、翻译、依赖、provider、hash 或生成时间。

## Schema 2

发布端与读取端只接受 schema 2。文档只有 `schema` 和 `rules`；每条规则只有：

- `id`：稳定 ID；文件归属使用 `OWN-xxxx`，已知构建失败使用 `BLD-xxxx`。
- `issue`：`file-ownership` 或 `build-failure`。
- `match`：`all-installed` 表示所有包必须为 Y；`all-selected` 表示所有包为 M/Y。
- `scope`：Source 到 Branch pattern 数组的映射。Source 可为具体 ID，或单独使用 `*`；Branch 支持精确值和 glob。`*` Source 不得与具体 Source 混用。
- `if`：可选 Kconfig 条件；不得复制已有依赖。
- `packages`：1–16 个真实 package ID。单包已知失败直接使用一个 ID，不伪造冲突方。
- `paths`：仅 `file-ownership` 必需，保存已确认重复归属的绝对路径。
- `refs`：1–8 个短证据引用，例如 `run:31319173318`，不复制完整日志。

网页执行链唯一为：

```text
evaluateCompatibilityRules → deriveCompatibilityPlans → applyUserIntent
```

规则不得包含命令、补丁或专用执行逻辑。构建端不得据此锁包或改写用户配置。用户可应用推荐方案、自定义 N/M/Y，或二次确认后强制继续。

规范化 JSON 未压缩上限 512 KiB。只有接近上限时才通过明确 schema 迁移按 Source/Branch 拆分；禁止提前维护平行数据集。

## 已登记规则

### OWN-0001

- 范围：ImmortalWrt `openwrt-25.12`，且 `USE_APK` 成立。
- 触发：`luci-app-openvpn-server=Y` 与 `openvpn-openssl=Y`。
- 问题：两包同时拥有 `/etc/config/openvpn`，APK 安装阶段发生文件归属冲突。
- 证据：Run `31248199953`、`31382153641`；两次均为 `trying to overwrite etc/config/openvpn owned by openvpn-openssl`。
- 处理：Catalog 通用 intent 比较关闭任一参与包的级联成本；只有唯一最低成本方案才推荐。用户仍可强制继续。
- 删除条件：上游消除重复归属并通过真实构建后，立即缩小 scope 或删规则。

### BLD-0001

- 范围：ImmortalWrt 全部 Branch 与 LEDE 全部 Branch，即 `ImmortalWrt:["*"]`、`lede:["*"]`。
- 触发：`oscam=M/Y`。
- 问题：多轮真实构建均在链接阶段缺失 `_binary_SoftCam_Key_start/end`；当前 Kconfig 没有能独立关闭该内部功能的 symbol。
- 证据：Run `31319173318`、`31343335898`、`31343364994`、`31343384324`、`31343420988`。
- 处理：推荐方案只通过 `applyUserIntent()` 把 `oscam` 调整为 N。强制继续不会修复源码，构建仍可能失败。
- 删除条件：任一上游范围修复后先用包级探测和真实构建确认，再缩小 scope；全部修复后删除。

### BLD-0002

- 范围：ImmortalWrt `master`。
- 触发：`luci-app-openvpn-server=M/Y`。
- 问题：该 Branch 当前由 `ovpn-dco` 在 Linux 6.18 的 `tcp.c` 编译失败；这是单包依赖闭包的源码构建失败，不是 `/etc/config/openvpn` 文件归属冲突。
- 证据：Run `31382119111`。
- 处理：推荐方案只通过通用 `applyUserIntent()` 把该包调整为 N；强制继续不会修补上游源码。
- 删除条件：上游修复并经包级探测与真实构建确认后删除。

## 维护、探测与发布

新增规则前先查上游源码和真实证据；确认一个范围后横向检查同 Source/Branch 机制。Source/Branch 新版本若已被 glob 覆盖，无需增加 JSON 项，但首次真实探测仍应记录证据。上游修复后及时删减，禁止 zombie rule。

### 探针深度边界

Catalog 的 **Package Compatibility Probe / 软件包兼容探针** 使用 Probe V3 协议，并把“配置事实”和“构建调度”分给各自权威：Catalog Kconfig 负责 Baseline、用户直接 Intent 与 Final `PACKAGE_*` 状态；进入真实上游源码后，软件包依赖、构建顺序、stamp 与增量构建由该 Source 自己的 Make 系统负责。

- **L1 软件包编译（`package-compile`）**：把用户在本次 Probe 中直接启用的软件包当作 Root。Runner 读取上游 `tmp/.packageinfo` 的 `Source-Makefile`，把 Binary Package 映射为真实源码构建目标；多个 Root 共用一个 Source 时自动去重，并用一次 Make 调用进入上游依赖图。WeiG 不逐个调度 Final 状态中的依赖包，也不维护 Binary→Source 或 dependency 数据库。L1 不执行 `package/install` 或固件镜像生成。
- **L2 根文件系统集成（`rootfs-integration`）**：完整执行 L1 后，再运行上游 `package/install`，使用完整 Final 软件包状态发现 APK/OPKG 文件归属、路径覆盖与共同安装冲突。
- **L3 固件集成（`firmware-integration`）**：在同一 Source/Branch/Target 环境中先构建 Probe 打开时真实 Baseline，再构建用户操作后的 Final。Baseline 本身失败只能记为 `inconclusive`；只有 Baseline 成功而 Final 失败时，才形成软件包引入的固件集成失败证据。
- **L4 启动自检（`boot-smoke`）**：L3 Final 成功后，仅对 Catalog 允许的通用可启动环境执行 QEMU 启动标志检查。它不是插件服务运行测试，也不是实体硬件功能测试。

`Defconfig` 与 L1–L4 正交，是默认开启但可关闭的独立开关。开启时运行所选 Source 自己的 `make defconfig`，并只强制验证用户直接启用的 Probe Root 在上游规范化后仍保持请求的 `m/y` 状态；自动依赖允许上游重新结算。关闭时不主动运行 `make defconfig`，L1 只为读取上游 package metadata 执行 `prepare-tmpinfo`。

Probe V3 的浏览器状态包含 Baseline、直接 `packageIntent`、唯一 Final `packageConfig`、Defconfig、五维环境约束和覆盖策略。不会传递 dependency list、build order 或第二个 packages/roots 权威；服务端从经过校验的直接 Intent 派生 Root。旧 `WEIG_PACKAGE_PROBE_STATE_V2` 请求明确拒绝，用户需要从当前 AutoBuild 页面重新提交。

环境范围由 Catalog 的真实结构动态解析，五个维度均可独立使用通配或精确值：**Source / Branch / Target System / Subtarget / Target Profile**。Target System、Subtarget 与 Profile 直接读取 Catalog core 已有的结构化字段，不从 `x86/64` 之类字符串反向猜测。通配保存的是规则而不是当前叶子快照，因此以后自动发现的新 Branch/Target/Profile 会自然进入匹配范围；不存在的组合记为不适用，不记为不兼容。

覆盖有两种模式。**Auto** 在管理员预算内做可复现的分层最大覆盖：候选不超过预算时全部执行，超过预算时只在未被用户固定的维度上优先覆盖不同 Source、Branch、Target System、Subtarget 和 Profile；抽样 seed 进入证据，新 Run 可以轮换样本。默认预算由 `.github/automation-policy.json` 管理：L1=200、L2=100、L3=30、L4=10，单批不超过 256。**全部遍历**覆盖所有真实候选；超过 256 时固定同一 Catalog data commit 与 sampling seed，按最多 256 个环境顺序续批，不一次制造数千个并发 Job。

抽样与全量结论严格分开：样本全部成功/失败只能记为 `sampled-compatible` / `sampled-incompatible`；完整覆盖后才允许 `fully-compatible` / `fully-incompatible`；同一范围内成功与失败并存为 `partially-compatible`。下载、磁盘、Runner、metadata 解析、Baseline 构建、取消与超时等不能归因到插件的情况统一保持 `inconclusive`。结果按 Source → Branch → Target System → Subtarget → Target Profile 聚合，因此可把问题收缩到具体源码、分支或目标范围，但证据不会自动宣称是某上游 Bug，也不会自动改写 `compatibility.json`。

Issue 网关仍以真实 Issue 作者和仓库权限作为权限事实，校验 V3 state token、SHA-256 与 Issue 身份后派发相同代码通道；后续批次继续固定第一次解析的 Catalog data commit。仓库 owner/admin 可使用管理员并发预算，write/maintain 协作者仍受 3 并发上限；普通访客不能启动 Matrix。请求者或具有 write/maintain/admin 权限的协作者可在同一 Issue 回复精确 `/cancel`，取消标记会同时停止当前 Run 并阻止后续批次。规范化证据保留 60 天，完整日志保留 30 天。

失败后的诊断遵循上游增量构建：耗时目标先按 Runner 可用 CPU 数加一执行；失败后对**同一批上游 Root targets**以 `-j1 V=s BUILD_LOG=1` 串行复核，复用同一工作树和 stamp。旧的“Final PACKAGE 全量逐包 compile”、fallback Target 循环和 `reduceFailureSet()`/`reductionMaxAttempts` 已不再属于 Probe 架构，Runner 不自行拆 dependency closure 或搜索最小失败集合。

代码 `main` 与正式数据 `catalog-data` 仍是独立生命周期：Builder `main` 只写 `catalog-candidate`，运行时/探针 `main` 读取 `catalog-data`；生产数据只能经手动 Production Gate 晋级。普通 Push、schedule 和 Probe 实验不能旁路 Production Gate。

GitHub Hosted Runner 仍受平台 Job 时限约束；各 Probe 深度的 timeout 由 `.github/automation-policy.json` 统一声明。达到超时只得到 `inconclusive`，不得当作软件包失败证据。

新增插件或规则前的硬顺序是：复用现有 Catalog 数据 → 横向审计同数据类型、执行路径和风险类别 → 先运行包级探针 → 再以真实证据维护通用规则。AutoBuild 不得写插件名或专用执行器。

仅 `compatibility.json` 变化时，Workflow 以稀疏 checkout 读取 `index.json` 和 `compatibility.json.gz`，调用 `build-index.mjs --compatibility-only`，不重跑 Source/Branch 矩阵。仅 `curated-sizes.json` 变化时同理调用 `--applications-only` 更新 `applications.json.gz`。生成器、Source 策略或 Workflow 变化仍运行完整矩阵。

中文与英文规则说明必须同步维护。English: [COMPATIBILITY.en.md](COMPATIBILITY.en.md)
