# WeiG OpenWrt Menuconfig Catalog

## Dynamic targets and primary translations / 动态目标与首选翻译

The catalog is the data authority for source branches, Target selectors and the complete
Kconfig menu tree. The web customizer does not keep source branches, targets or menu entries
in JavaScript.

Catalog 是源码分支、Target 动态选择器和完整 Kconfig 菜单树的数据权威；主网页不在
JavaScript 中写死分支、Target 或菜单项目。

- Canonical English comes from upstream `.targetinfo`, `.packageinfo` and `Config.in`.
- Simplified Chinese titles and usages come from `translations/zh-CN.json`.
- Options carry `depends on`, `visible if`, `select`, `imply`, defaults, ranges and parent paths.
- Target selectors are emitted as an ordered schema and tree. Empty trailing selectors are hidden,
  one-option selectors are auto-selected, and extra future selectors can be appended without HTML changes.
- Every generation writes a `*.translations.json` report for missing or stale Chinese work.
- Other languages are not generated here; clients fall back to canonical English.

英文以各上游源码为准；简体中文标题和用途由 Catalog 维护。每次生成都会输出翻译缺失报告，
其他语言暂不在本项目生成，缺失时回退英文。

Refresh the curated LuCI seed after the main project's curated plugin table changes:

```bash
node scripts/import-curated-i18n.mjs \
  ../WeiG-OpenWrt-AutoBuild/tools/plugins-meta.json \
  ../WeiG-OpenWrt-AutoBuild/tools/plugins-i18n.json
```

为 WeiG OpenWrt 在线定制器生成静态 menuconfig 目录。项目本身不编译固件。

目录内容来自 ImmortalWrt 稳定分支生成的 `tmp/.targetinfo`、`tmp/.packageinfo` 和
顶层 `Config.in` 树，包括：

- Source / Branch / Target System / Subtarget / Target Profile
- 顶层 `make menuconfig` 中可见的 bool、tristate、choice、string、int、hex
- `depends on`、`select`、`imply`、`default`、`range` 与菜单路径
- `menu/endmenu` 显式层级，以及 `menuconfig` 通过正向 `if/depends` 形成的隐式父子层级
- 软件包 Kconfig 选项及其依赖关系

网页已经用五级 Target 选择器提供设备/Profile，因此目录不会重复发布
`Target Devices` 菜单和对应的数千个 Kconfig 项，也不会把网页未使用的
软件包元数据塞进浏览器。

## 自动更新

`.github/workflows/catalog.yml` 每周检查 ImmortalWrt 的 21.02、23.05、
24.10 和 25.12 四个稳定分支。每个分支独立生成，失败时沿用上一次成功
数据。结果以无历史膨胀的孤立分支
`catalog-data` 发布，主站只按当前分支加载一个 gzip 分片。

- 矩阵不限制 `max-parallel`，由 GitHub 按账户并发额度调度。
- 所有元数据与压缩分片必须通过非空和解析检查。
- 成功阶段只输出名称和耗时；失败阶段在控制台显示关键错误及末尾 80 行，
  完整错误日志放入该分支唯一的结果 Artifact，保留 7 天。
- 本次失败但曾成功的分支标为 `stale`；从未成功的分支标为
  `unavailable`，不会伪装成最新数据。
- 只有全部分支成功时才更新固定 Release `menuconfig-catalog-complete`；
  部分失败只更新滚动目录，Workflow 保持失败状态。

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

本项目保留上游英文原文，并维护简体中文标题、用途与缺失报告；其他语言回退英文。
