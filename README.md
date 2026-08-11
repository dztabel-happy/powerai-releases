# PowerAI Releases

PowerAI 桌面端的公开安装包与自动更新入口。

本仓库不包含 PowerAI 源代码。可下载文件只通过 GitHub Releases 发布，不提交到 Git 历史。

## 当前状态

当前 `0.1.x` Release 是内部测试版本，不是正式公开发行版：

- Windows 安装包未签名，已完成 `0.1.5` → `0.1.6` 真实远程自动升级验收；
- macOS 安装包使用 ad-hoc 签名，可手动安装；应用内自动替换需 Developer ID 签名，内部测试阶段请下载新版 DMG 覆盖安装。

正式公开发行必须同时满足：

- 版本号已提升并与 Release tag 一致；
- macOS 制品已使用 Developer ID 签名并完成 Apple 公证；
- Windows 制品已完成代码签名；
- 自动更新元数据与安装包完整上传并通过校验；
- 从已安装旧版本完成 macOS 与 Windows 的发现、下载、重启和升级验收。

发布契约见 [docs/RELEASE_CONTRACT.md](docs/RELEASE_CONTRACT.md)。

## 安全说明

不要从非本仓库 Release 页面或 PowerAI 官方分发入口下载安装包。安全问题请按 [SECURITY.md](SECURITY.md) 报告。
