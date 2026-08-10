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
- 证据：Run `31248199953`。
- 处理：Catalog 通用 intent 比较关闭任一参与包的级联成本；只有唯一最低成本方案才推荐。用户仍可强制继续。
- 删除条件：上游消除重复归属并通过真实构建后，立即缩小 scope 或删规则。

### BLD-0001

- 范围：ImmortalWrt 全部 Branch 与 LEDE 全部 Branch，即 `ImmortalWrt:["*"]`、`lede:["*"]`。
- 触发：`oscam=M/Y`。
- 问题：多轮真实构建均在链接阶段缺失 `_binary_SoftCam_Key_start/end`；当前 Kconfig 没有能独立关闭该内部功能的 symbol。
- 证据：Run `31319173318`、`31343335898`、`31343364994`、`31343384324`、`31343420988`。
- 处理：推荐方案只通过 `applyUserIntent()` 把 `oscam` 调整为 N。强制继续不会修复源码，构建仍可能失败。
- 删除条件：任一上游范围修复后先用包级探测和真实构建确认，再缩小 scope；全部修复后删除。

## 维护、探测与发布

新增规则前先查上游源码和真实证据；确认一个范围后横向检查同 Source/Branch 机制。Source/Branch 新版本若已被 glob 覆盖，无需增加 JSON 项，但首次真实探测仍应记录证据。上游修复后及时删减，禁止 zombie rule。

Catalog 的手动 **Package probe controller** 可输入包 ID、Source/Branch glob、`compile` 或 `co-install`。它按数据分支 index 为每个组合派发独立 Run，仅编译选择的软件包闭包；`co-install` 还执行 `package/install`，用于暴露同装与文件归属问题。仓库所有者可选 1–20 并发，其他有写权限的协作者最多 3；dry-run 默认开启。

仅 `compatibility.json` 变化时，Workflow 以稀疏 checkout 读取 `index.json` 和 `compatibility.json.gz`，调用 `build-index.mjs --compatibility-only`，不重跑 Source/Branch 矩阵。仅 `curated-sizes.json` 变化时同理调用 `--applications-only` 更新 `applications.json.gz`。生成器、Source 策略或 Workflow 变化仍运行完整矩阵。

中文与英文规则说明必须同步维护。English: [COMPATIBILITY.en.md](COMPATIBILITY.en.md)
