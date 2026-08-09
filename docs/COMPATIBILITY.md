# Compatibility 证据规则

`compatibility.json` 只记录上游 Catalog/Kconfig 当前无法表达、但已有真实构建证据确认的软件包兼容事实。它不是第二套依赖数据库，也不能保存插件显示数据。

## 数据权威边界

新增字段前，必须先检查 Kconfig、Catalog relations、Catalog index 和现有运行时模型。已有事实只能引用稳定 ID，禁止复制 symbol 类型、N/M/Y、显示名称、翻译、依赖、provider、conflict、SHA、字节数或生成时间。

规则只允许 `id`、`kind`、`scope`、`if`、`packages`、`paths`、`refs`。网页根据 package ID 从 Catalog 模型查询 config symbol、可用状态和依赖关系，并用现有 intent 引擎推导最小修改方案。

## 字段

- `id`：稳定规则 ID；ownership 规则使用 `OWN-xxxx`。
- `kind`：第一版仅允许 `ownership`。
- `scope`：Source ID 到精确 branch 名称数组的映射。
- `if`：由现有 Kconfig 表达式引擎计算的附加条件。
- `packages`：发生兼容问题的真实 package ID。
- `paths`：已确认重复归属的绝对文件路径。
- `refs`：简短证据引用，例如 GitHub Actions Run ID；不得复制完整日志。

## 生命周期

每条规则必须有真实证据。新增分支前必须验证该分支实际失败，不能只根据源码目录相似推断。上游修复后应立即缩小 scope 或删除规则，不能保留 zombie 规则。

人工证据规则都是网页软警告：用户可以应用 Catalog 引擎推导的方案、在弹窗中调整状态，或者保留当前选择。构建端不得把它变成软件包锁。

发布时生成一个 `compatibility.json.gz`，直接写入 `catalog-fix`、`catalog-dev`、`catalog-staging` 或 `catalog-data` 数据分支；不为预览通道创建 Release。

规范化 JSON 的未压缩大小硬限制为 512 KiB，index 同时记录并由客户端核对压缩与未压缩字节数。文件接近上限时再通过一次明确的 schema 迁移按 Source 或 Source/Branch 拆分；不要提前维护多份空壳数据。

English documentation: [COMPATIBILITY.en.md](COMPATIBILITY.en.md)
