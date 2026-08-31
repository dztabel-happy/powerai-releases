# PowerAI 发布契约

## 1. 发布边界

- 本仓库只公开安装包、自动更新元数据和发行说明。
- 源代码和发布凭据不得写入 Git 历史、制品或日志。

## 2. 版本规则

- 使用 SemVer，应用版本、Git tag 和更新元数据版本必须一致。
- 正式通道使用 `vX.Y.Z`；dev 预发布使用 `vX.Y.Z-dev.N`（点号，顺接下一个正式版：
  `0.1.33 → 0.1.34-dev.1 → 0.1.34-dev.2 → 0.1.34`）。
- 版本号带预发布段时，Release 必须标记为 `prerelease` 且不得占据 `latest` 指针。
- **正式版必须由产品负责人明确确认后才能发布；未确认时一律发 dev 版。**
- 完整流程（通道、镜像目录与保留策略、客户端行为、命令）见 powerai-desktop 仓库的
  `docs/contributing/release.md`。
- 已发布版本及其制品不可覆盖或重新上传；修复必须提升版本号。

## 3. 必需制品

当前发布通道提供 Windows x64 与 macOS arm64。Windows 安装包暂不签名，Release 说明必须明确标注；macOS 用 Developer ID 签名并经 Apple 公证。

两条产线**互不阻塞**：Windows 构建完立即发布；macOS 提交 Apple 后不等待，由
`finalize-notarization` 轮询，公证通过后把 macOS 制品追加到同一个 Release。
Apple 排队时间不可预测，让发布等它是 2026-08 之前 macOS 停滞的直接原因。

macOS 仅提供 arm64（Apple Silicon）。Intel 机型不在当前发布范围内。

### macOS arm64

- `PowerAI-X.Y.Z-mac-arm64.dmg`
- `PowerAI-X.Y.Z-mac-arm64.zip`
- 对应 blockmap
- `latest-arm64-mac.yml`
- 兼容通道需要时发布 `latest-mac.yml`

### Windows（当前）

- `PowerAI-X.Y.Z-win-x64.exe`
- 对应 blockmap
- `latest.yml`
- 发布 ARM64 时增加安装包、blockmap 与 `latest-win-arm64.yml`

## 4. 原子发布

原子性以**平台**为单位，不以 Release 为单位：每个平台的安装包与它的更新元数据
必须同时出现，跨平台则允许先后。macOS 要等 Apple 公证，而 Apple 的排队时间没有
上界；把整个 Release 绑在它上面，就是 2026-08 之前 macOS 停滞的直接原因。

Windows（发布时立即完成）：

1. 从固定且已合并的源代码提交构建。
2. 完成制品验证。
3. 创建 Draft Release 并上传 Windows 全部制品。
4. 校验文件名、版本、大小、摘要和更新元数据引用。
5. 重新下载远端制品逐字节核对，一致后转为正式（dev 版标记 prerelease 且不取 latest）。

macOS（公证通过后追加到同一个 Release）：

1. 与 Windows 同一次运行、同一组提交，签名后提交 Apple，**不等待结果**。
2. 已发布的 Release 上挂 `notary-state.json` 作为待办标记。
3. `finalize-notarization` 轮询；Apple 判定 Accepted 后 staple、重建 dmg/zip。
4. 只校验并**追加** macOS 制品与 `latest-arm64-mac.yml`/`latest-mac.yml`，
   逐字节核对。**不得重传 Windows 制品**（它们已在公开下载中），
   **不得重设 Release 的 latest 指针**（该指针属于发布它的那条产线；在这里重设
   等于把它交给最后完成公证的版本，而那未必是最新版本）。
5. 终态必须清除标记：Accepted 追加后清除；Invalid 上传 Apple 日志、改标题后清除；
   待公证包超出保留期后改标题并清除。轮询按计划运行，留下无法完成的标记
   等于每 30 分钟失败一次，永不停止。

禁止先发布更新元数据、后补安装包；否则客户端可能发现一个无法下载的版本。

## 5. 客户端体验

- 后台检查到新版本后，在侧栏“设置”右侧显示蓝色“更新”按钮，不强制弹窗。
- 用户点击后开始下载并显示进度。
- 下载完成后按钮变为“重启更新”；用户确认后退出并安装。
- “设置 → 关于 → 检查更新”保留为手动入口。
- 更新失败必须保留当前可用版本，并向用户显示可重试错误。

## 6. Windows 真机验收

内测版本发布后，在真实 Windows 机器上使用已经安装的旧版本验证：

1. 发现新版本；
2. 下载进度与状态正确；
3. 重启并完成安装；
4. 应用版本已提升；
5. 用户会话和设置完整；
6. 首次启动完成固定版本、校验和受信任的 LibreOffice 安装，并以真实 DOCX → PDF 转换证明可用；
7. Windows 原生窗控的安全区有效，应用按钮不得进入最小化、最大化和关闭按钮区域；
8. 更新失败不会造成重启循环或不可启动状态。

上述验收用于确认真实机器上的 Windows Installer、网络、LibreOffice、原生窗控和用户数据行为，不阻塞内测安装包发布。发现问题时停止该版本分发，并以更高版本修复。

macOS 每次发布必须满足：Developer ID 签名（`codesign --verify --deep --strict`
且 Authority 为 Developer ID Application）、Apple 公证通过并 staple、
`spctl --assess` 放行。这三项由 `finalize-notarization` 强制执行，任何一项不过
就不追加 macOS 制品。

macOS 自动更新（旧版→新版）尚未在公开流水线上验收过。首个 macOS dev 版发布后
必须补做，未完成前不得据此宣布 macOS 升级链路可用。

## 7. 回滚

不覆盖旧 Release。出现问题时停止当前版本分发并发布版本号更高的修复版本；客户端不得静默降级。

## 8. 制品保留

- GitHub Release 中的安装包、更新元数据和来源证明是发布记录，不自动删除。
- GitHub Actions 构建中间产物保留 1 天，只用于同一次工作流内传递。唯一例外是
  待公证的 macOS 签名包（`macos-pending`，保留 14 天）：它要跨工作流交给
  `finalize-notarization`，且必须活过 Apple 的排队时间。诊断证据保留 3 天。
- 清理 Actions 中间产物不得删除 Release 资产，也不得改变已发布版本。
