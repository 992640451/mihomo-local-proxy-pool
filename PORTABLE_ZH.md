# 便携服务部署

简体中文 · [English](PORTABLE.md)

便携包以本地服务方式运行 Proxy Port Manager，并在默认浏览器打开管理页面，不需要 Docker、Git 或系统级 Node.js。

## Windows 双击使用（推荐）

1. 从 [Releases](https://github.com/992640451/mihomo-local-proxy-pool/releases) 下载 Windows 便携 ZIP。常见 x64 电脑选文件名含 `windows-x64.zip` 的附件，ARM 电脑选 `windows-arm64.zip`；不要选 `Source code`。
2. 右键 ZIP → **全部解压** 到可写目录，保留完整目录结构。不要直接在压缩包内运行，不要把单个 `.cmd` 移到桌面；可为它创建快捷方式。
3. 双击 **`启动管理器.cmd`**。首次显示“管理账号”和“管理密码”，请立即保存；密码只在生成时显示一次，不保存明文，也不写入后台日志。
4. 服务和内置 Mihomo 就绪后，默认浏览器自动打开管理页面。默认地址为 `http://127.0.0.1:4173`，实际以启动窗口为准。保存密码后按任意键关闭启动窗口，服务继续在后台运行。

再次双击“启动管理器.cmd”会检查已运行实例，正常时只重新打开页面。**`打开管理页面.cmd`** 只打开已运行服务；**`停止管理器.cmd`** 停止管理器和内置 Mihomo，保留 `data`。关闭浏览器或启动窗口不会停止服务；不提供开机自启，电脑重启后需要手动启动。

这三个入口从 **1.2.0** 开始随 Windows 包提供，公开下载以 Release 附件为准。旧包没有这些文件时，使用该包自带文档中的命令行方式。便携包内可直接双击阅读 [开始使用.txt](开始使用.txt)（[English](START_HERE.txt)）。

登录后的订阅导入、端口创建和应用接入见 [README：第一次使用](README.md#第一次使用)。管理端口 `4173` 不是代理端口，程序不会自动设置系统代理。

## Windows 命令行（进阶）

只有需要脚本或前台调试时才需要命令行。在解压目录中打开 PowerShell：

```powershell
# 前台运行；保持窗口开启，按 Ctrl+C 停止
.\bin\ppm.cmd start

# 或者后台运行（与双击启动相同）
.\bin\ppm.cmd start --background
.\bin\ppm.cmd status
.\bin\ppm.cmd open
.\bin\ppm.cmd stop
```

无需自动打开浏览器时添加 `--no-open`。首次使用 `--background` 启动时，管理密码仍只在当前终端显示一次，不会写入后台应用日志，请立即保存。

Windows 命令行入口已移到 `bin/ppm.cmd`，根目录不再保留旧入口，也不附带 Linux/macOS 的 `ppm`。已有脚本或命令行快捷方式需改用上面的新路径。`.\` 表示“当前目录”；日常使用三个中文双击入口即可。已有后台实例健康时，再运行 `start --background` 只打开页面，不再报重复启动错误。`data` 仍在解压根目录，不需要搬入 `bin`；不要移动或删除 `bin`。

## Windows 启动排查

- **找不到入口或提示找不到 Node.js**：确认不是 `Source code` 或旧包，完整解压后应有 `runtime/node.exe`、`core/mihomo.exe`、`app` 和 `bin/ppm.cmd`。无需另外安装 Node.js。
- **文件不能运行或被拦截**：核对 x64 / arm64 架构、官方来源和 [发布校验和](RELEASING.md#校验下载与使用镜像)。检查安全软件是否隔离文件，不要直接关闭安全防护或运行来源不明的副本。
- **启动失败 / 端口占用**：查看留在窗口中的错误与 `data/logs/application.log`、`data/logs/mihomo.log`。不要同时运行 Docker 版、旧版或另一份便携实例；默认管理端口 `4173`、控制端口 `19090` 都需要可用。
- **已有进程但不健康**：先双击“停止管理器.cmd”，确认成功后再启动；不要直接删除锁文件强行运行第二份。
- **没有自动打开网页**：访问窗口显示的管理地址，或双击“打开管理页面.cmd”；若提示未运行，先启动。
- **首次启动失败但已显示密码**：先保存密码再排查。配置可能已经生成，下次不会再显示相同密码。不要删除 `data/config.env` 重新初始化，它还包含订阅解密所需密钥。
- **忘记管理密码**：目前便携入口不提供密码重置，请勿照搬 Docker 的初始化命令。先停止服务并私下备份 `data`，再通过 [项目 Issues](https://github.com/992640451/mihomo-local-proxy-pool/issues) 联系维护者寻求保留密钥的恢复帮助；只提供版本和脱敏错误，不要上传 `data`、配置、密码或订阅链接。

## Linux 与 macOS

```bash
./ppm start
./ppm start --background
./ppm status
./ppm open
./ppm stop
```

## 数据与更新

便携数据位于解压根目录下的 `data` 目录，而非 `bin` 内。复制前先停止服务，保证订阅、加密密钥、会话、API 令牌、审计、检测历史与端口池一致。将新包解压到新目录，把备份的 `data` 复制进去，再启动新版本；不要同时运行两份实例。在验证新实例前保留旧目录和备份，不要让旧程序直接读取已被新版本升级的数据库。更新不得覆盖原 `data`。

可在「系统设置」下载口令加密配置恢复包，其中包含订阅与端口池，但不包含管理凭据、会话、API 令牌、审计、检测历史或检测调度设置。恢复是整体替换，需先预检并使用有效签名计划，不会修改主机端口映射。

无界面脚本可先在设置页创建作用域令牌，再使用 `ppm doctor`、`ppm ports list`、`ppm subscriptions refresh --all`、`ppm backup backup.json` 或 `ppm restore backup.json --plan plan.json`。恢复默认只预检，必须提供 `--apply --plan plan.json` 才执行。令牌状态保存在 `data/api-tokens.sqlite`。凭据文件与 v1 API 合同见 [自动化指南](AUTOMATION.md)。

1.2.0 提供节点延迟测试、端口历史和可选定时检测，后台检测默认关闭；设置及样本保存在 `data/observability.sqlite`。详见 [可观测性](OBSERVABILITY.md)。

「系统设置」也能运行组件诊断并导出脱敏 JSON；操作记录保存在 `data/audit.sqlite`，受保留天数及最大条数限制。

管理 API、Mihomo Controller 和生成的代理监听默认绑定回环地址。没有 TLS、认证及明确网络隔离时，不要向局域网或公网开放。

## 构建便携归档

构建网页并下载与当前系统/架构匹配、经过 SHA256 校验的固定版 Mihomo：

```bash
npm run portable:build
```

使用自备核心时，先运行 `npm run build`，再执行 `npm run portable:package -- --core /path/to/mihomo`。自备核心不会标记为清单验证，因此不能通过公开发布门禁。

归档输出到 `.artifacts/portable`。每个系统/架构应在匹配的 CI runner 上构建，因为 Node.js 和 Mihomo 都是原生二进制。

发布矩阵覆盖 Windows、Linux、macOS 的 x64 与 arm64。每包包含 CycloneDX SBOM 和构建元数据，对应附加文件也由 `SHA256SUMS.txt` 覆盖。SBOM 记录 npm 构建依赖图（含前端与构建工具）和内置 Node/Mihomo，不是其完整原生传递依赖清单。设置页显示源码提交、UTC 构建时间、目标及运行时版本。`start` 或 `restart` 可添加 `--no-open`，也可与 `--background` 一起使用。

CI 门禁、制品校验、GHCR 镜像及中断恢复见 [发布工程](RELEASING.md)。
