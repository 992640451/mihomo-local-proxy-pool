# 便携服务部署

简体中文 · [English](PORTABLE.md)

便携包以本地服务方式运行 Proxy Port Manager，并在默认浏览器打开管理页面，不需要 Docker、Git 或系统级 Node.js。

## Windows

解压到可写目录后运行：

```powershell
.\ppm.cmd start
```

首次启动显示自动生成的管理密码，请立即保存。管理服务与内置 Mihomo 均健康后，浏览器会打开 `http://127.0.0.1:4173`。

无需保持终端开启时：

```powershell
.\ppm.cmd start --background
.\ppm.cmd status
.\ppm.cmd open
.\ppm.cmd stop
```

无需自动打开浏览器时添加 `--no-open`。首次使用 `--background` 启动时，管理密码仍只在当前终端显示一次，不会写入后台应用日志，请立即保存。

## Linux 与 macOS

```bash
./ppm start
./ppm start --background
./ppm status
./ppm open
./ppm stop
```

## 数据与更新

便携数据位于启动器旁的 `data` 目录。复制前先停止服务，保证订阅、加密密钥、会话、API 令牌、审计、检测历史与端口池一致。将新包解压到新目录，把备份的 `data` 复制进去，再启动新版本；不要同时运行两份实例。在验证新实例前保留旧目录和备份，不要让旧程序直接读取已被新版本升级的数据库。更新不得覆盖原 `data`。

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
