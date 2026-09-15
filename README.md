# PowerAI

PowerAI 桌面端，支持 Windows x64 和 macOS Apple Silicon。

[下载最新正式版](https://github.com/dztabel-happy/powerai-releases/releases/latest)

本公开仓库统一运行 dev、正式版构建，以及发布后的安装包验收。应用源码和验收脚本保留在私有源码仓库；工作流通过只读部署密钥读取固定提交，公开制品只包含安装包、更新元数据和测试结果。

- 发版：`build-release.yml`；macOS 公证收尾：`finalize-notarization.yml`。
- 升级验收：`verify-desktop-update.yml`，通过 `target_channel=stable|dev` 选择通道。
- 其他验收：工作簿预览、swap helper、OfficeCLI 和打包后的会话连续性测试。

输入、证据保留和发布边界见 [发布契约](docs/RELEASE_CONTRACT.md)。

Windows ARM64 is an opt-in architecture of the same release workflow:
`windows_arm64=true` includes it in publication; `mode=arm64-candidate` builds and
checks feature commits without publishing. Existing dispatches keep Windows x64
and macOS arm64. See [the architecture contract](docs/RELEASE_CONTRACT.md#windows-arm64-optional-architecture).
