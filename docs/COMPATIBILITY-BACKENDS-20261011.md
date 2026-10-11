# 后端缺失：证据、候选和原生限制

复用 schema 7 `compatibility.json`，不新建故障数据库、包名特判或 Worker 软件门禁。
`relations` 表达原生关系；真实构建证据确认故障后才写兼容规则。

## BLD-0015：已确认的 RootFS 安装故障

- Source/Branch：iStoreOS / istoreos-24.10；源码 `fb971407ffd9a094e6f16d9c029f1f580ed5c2ad`。
- 目标：x86 / 64 / DEVICE_generic。
- feeds receipt SHA-256：`750cca36b6786ae99dd924ca03867f49e04982bd5264cc09a19d5775783543f5`。
- Catalog 关系快照：`a0894cc10da028bcfed353b409f017a9f93ab46b`。
- [失败 Run 37603997193](https://github.com/weigefenxiang/WeiG-OpenWrt-AutoBuild/actions/runs/37603997193)，job 112735039803。
- [固定 feeds 的前端 Makefile](https://github.com/jjm2473/openwrt-third/blob/335fa421e0fcd673a78986117981d4dfa3bf57d7/luci-app-baidupcs-web/Makefile)：`LUCI_DEPENDS` 包含 `+baidupcs-web`；当前完整元数据没有该后端定义或提供者。

原生 Kconfig 可选择前端 Y，前端 package compile 成功，但 package/install 报：

```text
pkg_hash_check_unresolved: cannot find dependency baidupcs-web for luci-app-baidupcs-web
opkg_install_cmd: Cannot install package luci-app-baidupcs-web.
```

后续“incompatible with the architectures configured”是安装候选失败的次级提示，不能据此改 Target。
规则只匹配这份源码/feeds 和目标的已安装 Y；无 `buildDependency`，因为这是安装依赖缺失，
不是某个后端构建单元失败。M 不安装到 RootFS，不外推此证据。

[成功 Run 37593841726](https://github.com/weigefenxiang/WeiG-OpenWrt-AutoBuild/actions/runs/37593841726)
是 Lienol/25.12，存在并安装后端，不能用 iStoreOS 证据禁止该源。

## 当前静态扫描候选（不等于构建失败事实）

范围是上述完整 Catalog 快照的 6 Source / 26 Branch 关系图；下表不是额外规则库。
需要在相同源码/feeds/目标下复用现有 L3 RootFS integration 或已有完整 Run 证据确认。
超时、基础系统先失败、下载或未知条件只记未定，不能据此自动禁包。

| 候选 | 当前静态观察范围 | 缺少项 / 处理边界 |
| --- | --- | --- |
| luci-app-baidupcs-web | iStoreOS 21.02/22.03/23.05/24.10/25.12 | 后端 baidupcs-web；本轮只确认并记录 24.10 的精确环境 |
| luci-app-radicale3 | OpenWrt、ImmortalWrt、iStoreOS、Lienol 的 24.10 | rpcd-mod-rad3-enc；待 RootFS 证据 |
| luci-app-mwan3helper | Lienol 19.07/23.05/24.10/25.12 | pdnsd-alt；待 RootFS 证据 |
| Babeld / BMX7 的 LuCI 前端 | OpenWrt main、ImmortalWrt master | 原生后端缺失候选；待精确安装证据 |
| luci-app-diskman | Lienol 19.07 | kmod-fs-ntfs3；须先核对真实 Target 条件 |
| 动态 qBittorrent | Lienol 25.12 | rblibtorrent → boost-system；不是另一个 libtorrent-rasterbar 包 |

## 保持原生限制，不写兼容故障规则

- `luci-app-mtwifi`：Lienol 的原始 Makefile 有 `@TARGET_ramips` 与 `+kmod-mt_wifi`；x86 不可选是硬件条件。其它源必须消费自己的 Target/Subtarget/Profile 关系，不能按相同包名外推。
- `luci-app-qmodem-hc`：设备 Profile、USB/PCI 和驱动条件仍由 Kconfig 表达，不自动更换目标。
- `luci-app-ltqtapi`：原生 BROKEN 条件，不把开启 BROKEN 当作安全修复。
- KodExplorer 的 NGINX 条件及 PBR/Tailscale 的 provider 切换：复用原生最少合法动作，不另维护包名修补。
- Lienol NSS/Libreswan 的 feeds 源路径误判是上游准备阶段问题；共享适配器仍是独立待确认事项，不记全局禁包规则。
- ext4 分区容量、Runner OOM、网络、磁盘、执行超时不属于 package compatibility。

网页只在“检/提交”打开一个编译警示审阅：原生配置一致性与已确认规则共用 N/M/Y、
推荐、变更预览和强制审计。取消前端只是风险规避，不假装补齐缺失后端。
Worker 按原配置重建并执行，不再否决强制选择。
