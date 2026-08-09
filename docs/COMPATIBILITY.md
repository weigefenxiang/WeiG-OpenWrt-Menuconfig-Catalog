# Compatibility 证据规则

`compatibility.json` 只记录上游 Catalog/Kconfig 当前无法表达、但真实构建证据已经确认的兼容性问题。它不是第二套依赖数据库，也不保存 symbol 类型、N/M/Y、显示名称、翻译、依赖、provider、conflict、SHA 或生成时间；这些事实始终由 Catalog 提供。

## Schema 2

文档只允许 `schema` 和 `rules`。每条规则只允许以下字段：

- `id`：稳定规则 ID。文件归属使用 `OWN-xxxx`，已知构建失败使用 `BLD-xxxx`。
- `issue`：`file-ownership` 或 `build-failure`，只选择通用校验和提示语义。
- `match`：`all-installed` 要求全部软件包为 `Y`；`all-selected` 要求全部为 `M/Y`。
- `scope`：Source ID 到精确 branch 名称数组的映射。
- `if`：可选的额外 Kconfig 表达式；不应复制已有依赖事实。
- `packages`：1–16 个真实 package ID。网页通过 Catalog 查找 config symbol、合法状态和依赖级联。
- `paths`：仅 `file-ownership` 必需，保存已确认重复归属的绝对路径。
- `refs`：1–8 个简短证据引用，例如 GitHub Actions Run ID；禁止复制完整日志。

网页统一使用 `evaluateCompatibilityRules()` 判断、`deriveCompatibilityPlans()` 推导方案，并由唯一状态执行器 `applyUserIntent()` 应用。规则不得包含命令、补丁或专用执行逻辑。构建端不得据此锁包或改写用户配置。用户可以应用推荐方案、自定义 N/M/Y，或二次确认后保留选择并强制继续。

读取端在迁移期兼容 schema 1 的 `ownership`，发布端统一输出 schema 2。规范化 JSON 的未压缩上限为 512 KiB；接近上限时再通过明确的 schema 迁移按 Source 或 Source/Branch 拆分，禁止预先维护空的平行数据集。

## 已登记规则

### OWN-0001

- 范围：ImmortalWrt `openwrt-25.12`，且 `USE_APK` 成立。
- 触发：`luci-app-openvpn-server=Y` 与 `openvpn-openssl=Y`。
- 问题：两个软件包同时拥有 `/etc/config/openvpn`，APK 安装阶段会发生文件归属冲突。
- 证据：GitHub Actions Run `31248199953`。
- 处理：网页用 Catalog 通用 intent 计算关闭任一相关软件包的级联成本，只有唯一最低成本方案才标为推荐；用户仍可强制继续。
- 删除条件：上游消除重复文件归属后，使用真实构建验证；随即缩小 `scope` 或删除规则。

### BLD-0001

- 范围：ImmortalWrt `openwrt-25.12`。
- 触发：`oscam=M/Y`。
- 问题：该分支的软件包使用 OSCam 内部默认启用的 `WITH_EMU` 与 `WITH_SOFTCAM`，已确认链接阶段缺少 `_binary_SoftCam_Key_start/end`。这不是当前 OpenWrt Kconfig 中可单独关闭的 symbol。
- 证据：GitHub Actions Run `31319173318`。
- 处理：推荐方案仅通过 Catalog 的 `applyUserIntent()` 将整个 `oscam` 调整为 `N`。强制继续不会修复源码，构建仍可能失败；保留 OSCam 的根本修复应提交上游。
- 删除条件：上游修复链接问题或公开可用的 Kconfig 选项后，先用真实构建验证，再缩小 `scope` 或删除规则。

`OSCAM_S_CACHEEX` 与软件包 Makefile 中 `CONFIG_OSCAM_CS_CACHEEX` 的命名差异是独立问题；在确认它造成实际失败前，不并入 BLD-0001。

## 维护与发布

新增 scope 前必须验证该分支真实失败，不能依据相似目录推断。上游修复后必须及时删减规则，禁止 zombie rule。

仅 `compatibility.json` 变化时，工作流读取对应数据分支现有的 `index.json` 与 `compatibility.json.gz`，复用 `build-index.mjs --compatibility-only` 更新兼容性资产及其契约；Source/Branch Catalog 资产和哈希保持原样，相同内容不重复提交。生成器、验证器、工作流或采集配置变化时仍运行完整矩阵。

English: [COMPATIBILITY.en.md](COMPATIBILITY.en.md)
