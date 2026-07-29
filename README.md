# WeiG OpenWrt Menuconfig Catalog

为 WeiG OpenWrt 在线定制器生成静态 menuconfig 目录。项目本身不编译固件。

目录内容来自各上游分支生成的 `tmp/.targetinfo`、`tmp/.packageinfo` 和
顶层 `Config.in` 树，包括：

- Source / Branch / Target System / Subtarget / Target Profile
- 顶层 `make menuconfig` 中可见的 bool、tristate、choice、string、int、hex
- `depends on`、`select`、`imply`、`default`、`range` 与菜单路径
- 软件包分类、标题、依赖和架构信息

## 自动更新

`.github/workflows/catalog.yml` 每周检查四个上游。每个源码/分支独立生成，
失败的分支沿用上一次成功数据。结果以无历史膨胀的孤立分支
`catalog-data` 发布，主站只按当前分支加载一个 gzip 分片。

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

本项目不含翻译；Target、Profile 和菜单名称保持上游原文。
