<p align="center">
  <img src="assets/readme-hero.png" alt="三个代理节点汇入一个本地端口，再连接到本机应用" width="100%" />
</p>

<h1 align="center">Proxy Port Manager</h1>

<p align="center">
  把多个 Mihomo / Clash 节点，变成一个稳定、可观察的本地代理端口。
</p>

<p align="center">
  简体中文 · <a href="README_EN.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/992640451/mihomo-local-proxy-pool/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/992640451/mihomo-local-proxy-pool/ci.yml?branch=main&style=flat-square" alt="CI" /></a>
  <a href="https://github.com/992640451/mihomo-local-proxy-pool/releases/latest"><img src="https://img.shields.io/github/v/release/992640451/mihomo-local-proxy-pool?style=flat-square" alt="Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/992640451/mihomo-local-proxy-pool?style=flat-square" alt="MIT License" /></a>
  <a href="https://github.com/992640451/mihomo-local-proxy-pool/stargazers"><img src="https://img.shields.io/github/stars/992640451/mihomo-local-proxy-pool?style=flat-square" alt="GitHub Stars" /></a>
  <img src="https://img.shields.io/badge/scope-localhost-34d399?style=flat-square" alt="Localhost only" />
</p>

<p align="center">
  <a href="#3-分钟启动"><strong>3 分钟启动</strong></a> ·
  <a href="#第一次使用"><strong>第一次使用</strong></a> ·
  <a href="#如何让应用使用代理"><strong>接入应用</strong></a> ·
  <a href="#常见问题"><strong>常见问题</strong></a>
</p>

---

```text
多个订阅节点  ──►  127.0.0.1:17900  ──►  浏览器 / 爬虫 / 开发工具
                    固定本地入口
```

你的应用只需要记住一个本地端口。节点选择、故障切换、健康检查和轮询都由 Proxy Port Manager 与 Mihomo 完成。

## 为什么使用它

| 固定入口 | 自动调度 | 看得见、可验证 |
| --- | --- | --- |
| 节点变化时，应用里的代理地址不用改 | 节点失败后自动跳过，支持 5 种策略 | 浏览器管理端口池，一键检测监听与出口分布 |

适合本地开发、爬虫、自动化工具或任何需要稳定 HTTP / SOCKS5 代理入口的应用。

## 1.2.0 更新重点

本分支版本为 **1.2.0**；已公开的安装包及镜像以 [Releases](https://github.com/992640451/mihomo-local-proxy-pool/releases) 为准。更新源码不会自动更新已发布的安装包。

- **节点与端口可观测性**：真实节点健康、批量延迟测试、端口验证历史和 24 小时失败趋势。后台检测默认关闭，可按需开启并限制流量与历史容量。
- **脚本自动化**：提供 `/api/v1`、OpenAPI、可撤销的作用域令牌，以及 `ppm doctor / backup / restore / ports list / subscriptions refresh`。
- **恢复前预检**：先查看订阅、节点和端口的增改删，再用有效期为 10 分钟的签名计划显式应用；配置变化后必须重新预检。
- **可靠性修复**：订阅变更在 Mihomo 确认重载后才提交，失败恢复原状态；加强 YAML 错误、历史审计脱敏和调度器异常诊断。
- **Windows 双击使用**：完整解压便携包后，双击“启动管理器.cmd”即可后台运行并打开页面，提供独立的打开/停止入口和中英文入门说明。

详细用法见 [可观测性](OBSERVABILITY.md)、[自动化 API 与 CLI](AUTOMATION.md) 和 [完整变更记录](CHANGELOG.md)。

> [!IMPORTANT]
> 本项目只管理你有权使用的订阅，不提供代理节点。默认仅监听 `127.0.0.1`，定位是单机、本地代理池，不是公网代理服务。

## 3 分钟启动

项目支持两种本地部署方式：

- **便携服务包（新手推荐）**：适合 Windows、Linux 和 macOS，不需要安装 Docker、Git 或系统级 Node.js；启动后使用浏览器管理。
- **Docker Compose（进阶部署）**：适合已有 Docker 的开发机、NAS 和长期运行环境。

### Windows：下载、解压、双击启动（推荐）

1. 打开 [Releases](https://github.com/992640451/mihomo-local-proxy-pool/releases)，在附件中下载文件名含 `windows-x64.zip` 的便携包；ARM 电脑选择 `windows-arm64.zip`。**不要下载 `Source code` 源码包。**
2. 右键 ZIP → **全部解压**，放到自己的可写目录。不要在压缩包里直接运行，也不要单独移动启动文件。
3. 双击 **`启动管理器.cmd`**，等待就绪。第一次会显示“管理账号”和“管理密码”，请立即保存到密码管理器。
4. 浏览器自动打开管理页面，使用刚才的账号和密码登录。保存密码后，按任意键关闭启动窗口即可，服务会继续在后台运行。

默认管理地址为 [http://127.0.0.1:4173](http://127.0.0.1:4173)。若浏览器未打开，使用启动窗口显示的地址手动访问。

日常只需记住三个文件：

| 文件 | 双击后的行为 |
| --- | --- |
| `启动管理器.cmd` | 后台启动并打开页面；已经正常运行时直接打开，不重复启动 |
| `打开管理页面.cmd` | 打开已运行的管理页面；未运行时提示先启动 |
| `停止管理器.cmd` | 停止管理器和内置 Mihomo，保留数据 |

Windows 包根目录只保留这三个操作入口；底层命令行入口收在 `bin` 文件夹内，不需要手动打开，但请勿移动或删除。

关闭浏览器或启动窗口**不会停止代理**；电脑重启后需要再次双击启动，没有开机自启。密码仅在首次生成时显示，不会写入后台日志。

这些双击入口从 **1.2.0** 开始随 Windows 便携包提供；公开下载是否已包含它们以 Release 附件为准，旧包可参照其自带的便携部署文档。解压目录内可双击阅读 [开始使用.txt](开始使用.txt)（[English](START_HERE.txt)）。需要命令行操作时见 [便携部署文档](PORTABLE_ZH.md#windows-命令行进阶)。

便携版把订阅、密钥、会话和端口池保存在解压目录的 `data` 文件夹中。更新前先停止服务并备份该目录，不要用新包覆盖它。详细说明见 [便携部署文档](PORTABLE_ZH.md)。

### Linux / macOS 便携部署

下载对应系统与架构（x64 或 arm64）的 `.tar.gz`，解压后进入目录：

```bash
./ppm start
# 无需自动打开浏览器时：
./ppm start --background --no-open
./ppm status
./ppm stop
```

默认管理地址同样为 `http://127.0.0.1:4173`。首次启动即使使用后台模式，管理密码也只在当前终端显示一次，请立即保存。

### Docker Compose（进阶部署）

#### 1. 准备环境

- Git
- Node.js 22 或更高版本
- Docker Desktop，或 Docker Engine + Compose

Windows 用户请确认 Docker Desktop 正在使用 Linux containers。

#### 2. 安装并启动

```bash
git clone https://github.com/992640451/mihomo-local-proxy-pool.git
cd mihomo-local-proxy-pool
npm run init
docker compose up -d --build
```

`npm run init` 会创建本机专用的 `.env`、随机密钥和管理员密码。请保存终端中显示的密码；密码不会写入仓库。

#### 3. 打开管理页面

访问 [http://127.0.0.1:4173](http://127.0.0.1:4173)，使用初始化时显示的账号和密码登录。

检查服务是否正常：

```bash
docker compose ps
curl http://127.0.0.1:4173/healthz
```

看到 `status: ok` 即表示管理服务已经就绪。

## 第一次使用

1. 打开左侧 **订阅**，填写订阅 URL，或粘贴 Mihomo / Clash YAML。
2. 打开 **代理端口**，点击 **新建端口池**。
3. 使用端口 `17900`，协议选择 `Mixed`。只选一个节点时，策略设为 **手动选择**；保留默认 **主备切换** 时至少选择两个节点。
4. 保存后点击 **检测**，确认显示“监听可连接”。
5. 点击端口旁对应协议的图标按钮，把代理地址粘贴到需要代理的应用中。
6. 在 **节点** 测试所选节点延迟，在 **可观测性** 查看验证历史；需要定时检测时再手动开启后台检测。

“监听可连接”仅说明端口接受连接；请再点击 **验证** 检查是否能通过代理访问出口查询服务。节点“测速”测量请求延迟，不是下载带宽。

想使用轮询时，选择至少两个节点，并把策略改成 **轮询均衡**。轮询只对新连接生效，已建立的 TCP 连接不会在节点之间迁移。

## 如何让应用使用代理

假设已经创建 Mixed 端口 `17900`：

### 命令行

```bash
# HTTP / HTTPS
curl --proxy http://127.0.0.1:17900 https://api.ipify.org

# SOCKS5，并让代理端解析域名
curl --proxy socks5h://127.0.0.1:17900 https://api.ipify.org
```

Windows PowerShell 可把 `curl` 替换为 `curl.exe`。

### 环境变量

```text
HTTP_PROXY=http://127.0.0.1:17900
HTTPS_PROXY=http://127.0.0.1:17900
ALL_PROXY=socks5h://127.0.0.1:17900
```

浏览器、IDE、下载器和爬虫通常也支持直接填写代理地址：主机使用 `127.0.0.1`，端口使用你创建的端口。

## 如何确认轮询生效

1. 为端口池选择至少两个健康节点。
2. 策略选择 **轮询均衡** 并保存。
3. 在端口列表点击 **验证**。
4. 系统会建立 8 个独立连接，并显示成功率、出口 IP 分布和平均延迟。

出现多个出口 IP，通常说明轮换已经生效。不同节点也可能共用同一公网出口，因此只有一个出口 IP 不一定代表轮询失败；请同时查看节点健康状态和 Mihomo 日志。

## 策略怎么选

| 策略 | 适合场景 | 行为 |
| --- | --- | --- |
| 手动选择 | 只想固定使用一个节点 | 始终使用指定节点 |
| 主备切换 | 稳定性优先 | 主节点失败后按顺序切换 |
| 延迟优选 | 速度优先 | 自动选择当前延迟较低的节点 |
| 稳定哈希 | 希望相同目标尽量走相同节点 | 按目标稳定分配节点 |
| 轮询均衡 | 希望新连接分散到多个节点 | 按连接轮换健康节点 |

自动策略只使用通过健康检查的节点。节点不足、端口超出范围或订阅更新移除了节点时，服务会拒绝保存并说明原因。

## 核心功能

- 导入订阅 URL 或粘贴 Mihomo / Clash YAML。
- 加密保存订阅，刷新失败时继续使用最后一个可用版本。
- 创建 HTTP、SOCKS5 或 Mixed 本地端口池。
- 健康检查、自动跳过故障节点和 Mihomo 热重载。
- 端口监听检测与多连接出口分布验证。
- 节点实时健康与批量测速、端口验证历史、24 小时失败趋势；后台检测默认关闭。参见 [可观测性说明](OBSERVABILITY.md)。
- 会话、订阅和端口池持久化，容器重建后仍可恢复。
- 口令加密的配置备份与失败自动回滚。
- 持久化操作审计与脱敏系统诊断导出。
- 带作用域的 API 令牌、版本化 API、OpenAPI 和脚本命令；恢复预检与显式应用。
- 可选迁移 Clash Verge 远程订阅。

## 它如何工作

```text
本机应用
   │ HTTP / SOCKS5
   ▼
127.0.0.1:17900 ──► Mihomo 策略组 ──► 健康节点 ──► 互联网
                           ▲
                           │ 本机 Controller API
浏览器 ──► 127.0.0.1:4173 ─┘
```

Compose 默认发布 `17891-17893` 和 `17900-17999`。如果启动时报端口占用，请检查整个范围。

## 常用命令

网页更新：登录后点击侧栏底部版本按钮或“系统设置 → 版本更新”。新便携包可直接使用，Docker 首次需接入独立更新器，详见 [网页版本更新](docs/UPDATING.md) / [English](docs/UPDATING_EN.md)。更新会自动备份、重启并核验目标版本。

以下命令适用于 **Docker / 源码部署**，Windows 便携用户日常使用上面的三个双击入口即可。

```bash
# 查看状态
docker compose ps

# 查看日志
docker compose logs -f --tail=100

# 更新到最新代码
git pull --ff-only
npm run docker:update

# 停止服务但保留数据
docker compose down
```

不要随意运行 `docker compose down -v`，它会删除订阅、会话和端口池数据。

本地修改代码后运行 `npm run docker:update`。该命令会重建并强制替换管理服务容器，等待健康检查通过后再结束，不会重建 Mihomo 容器，也不会删除持久化数据。

需要持续开发时，可在单独终端运行：

```bash
npm run docker:watch
```

Compose 会监听应用源码、服务端代码、依赖和容器配置的变化，并自动重建管理服务容器。结束监听可按 `Ctrl+C`，已启动的容器会继续运行。

### 忘记管理密码

```bash
npm run init -- --reset-password
docker compose up -d --force-recreate proxy-port-manager
```

该命令只重置管理员凭据，不会更换订阅加密密钥。

## 数据与安全

- `.env` 包含本机密钥，已被 Git 忽略，请勿分享。
- 订阅 URL、原始 YAML 和节点敏感字段使用 AES-256-GCM 加密后写入 SQLite。
- “系统设置”可以下载口令加密恢复包；恢复是整体替换，包中没有的资源会被删除，必须先预检。恢复包不包含管理认证、会话、API 令牌、审计、检测历史或检测调度设置，也不修改目标机器的端口映射。
- 恢复包原始数据上限为 24 MiB，加密文件上限为 33 MiB；超限时会拒绝导出，避免生成无法导入的备份。
- “操作记录”保存在服务端并在写入前脱敏；诊断导出不包含完整订阅 URL、节点凭据、Cookie 或控制器密钥。
- 默认 Compose 只绑定 `127.0.0.1`；不要在没有额外认证和网络隔离时改成 `0.0.0.0`。
- `proxy-session-data` 保存订阅、会话、API 令牌摘要、审计、检测历史/设置和端口池；`proxy-mihomo-data` 保存 Mihomo 运行配置。
- 管理登录不等同于代理端口认证。API 令牌只在创建时显示一次，应按脚本分配最小权限，不要放入命令参数、仓库或日志。

安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## 从 Clash Verge 迁移

新安装不依赖 Clash Verge。如果需要导入 Clash Verge 的远程订阅，请阅读 [Docker 部署文档](DOCKER_ZH.md)。迁移完成后应切回默认的原生订阅模式。

## 常见问题

<details>
<summary><strong>Windows 双击启动失败，或找不到启动文件</strong></summary>

确认下载的是包含双击入口的 Windows 便携 ZIP，而不是 `Source code` 或旧版本；完整解压后应有 `runtime`、`core`、`app` 和 `bin/ppm.cmd`。不要同时运行 Docker 版或另一份便携版，以免端口冲突。窗口会保留错误信息，详细日志在 `data/logs/application.log` 和 `data/logs/mihomo.log`；更多排查见 [便携部署](PORTABLE_ZH.md#windows-启动排查)。

</details>

<details>
<summary><strong>代理端口可以连接，但出口没有变化</strong></summary>

轮询针对新连接。关闭连接复用，或使用多个独立 `curl` 进程测试；同时确认至少两个节点通过健康检查。

</details>

<details>
<summary><strong>端口没有监听</strong></summary>

Docker 用户运行 `docker compose ps` 和 `docker compose logs mihomo-core`，确认端口位于已发布范围且未被占用。Windows 便携用户先双击“启动管理器.cmd”确认启动成功，再查看 `data/logs/mihomo.log` 和页面中的端口配置；详见 [便携排查](PORTABLE_ZH.md#windows-启动排查)。

</details>

<details>
<summary><strong>初始化提示 .env 已存在</strong></summary>

这是防止误覆盖密钥的保护。已有安装不需要重新初始化；如果只是忘记密码，请使用 `npm run init -- --reset-password`。

</details>

<details>
<summary><strong>容器重建后数据会丢失吗？</strong></summary>

不会。默认使用 Docker volumes 持久化。除非你显式删除 volumes，否则 `docker compose down` 和重新构建镜像不会删除数据。

</details>

## 开发

```bash
npm ci
npm test
npm run build
npm run dev
```

开发服务默认使用前端 `4173`、API `4180`；不要与同端口的 Docker / 便携实例同时启动。实际代理功能还需配置可用的 Mihomo。仅检查界面时可在构建后运行 `node tests/helpers/observability-preview.mjs --auth`，使用其隔离的临时数据与模拟核心，详见 [自动化指南](AUTOMATION.md)。

## 文档导航

保留已有文档文件名，每篇指南均提供对应语言链接。英文文档不代表管理界面已提供英文翻译；当前界面主要使用中文。

| 主题 | 简体中文 | English |
| --- | --- | --- |
| Docker 部署 | [阅读](DOCKER_ZH.md) | [Read](DOCKER.md) |
| 便携部署 | [阅读](PORTABLE_ZH.md) | [Read](PORTABLE.md) |
| 可观测性 | [阅读](OBSERVABILITY.md) | [Read](OBSERVABILITY_EN.md) |
| 自动化 API 与 CLI | [阅读](AUTOMATION.md) | [Read](AUTOMATION_EN.md) |
| 发布流程与校验 | [阅读](RELEASING.md) | [Read](RELEASING_EN.md) |
| 变更记录 | [阅读](CHANGELOG.md) | [Read](CHANGELOG_EN.md) |
| 贡献指南 | [阅读](CONTRIBUTING.md) | [Read](CONTRIBUTING_EN.md) |
| 安全政策 | [阅读](SECURITY.md) | [Read](SECURITY_EN.md) |
| 架构与演进 | [阅读](docs/ARCHITECTURE.md) | [Read](docs/ARCHITECTURE_EN.md) |
| 第三方声明 | [阅读](THIRD_PARTY_NOTICES_ZH.md) | [Read](THIRD_PARTY_NOTICES.md) |

## 项目状态

当前是早期版本，专注单机、本地代理池。公网代理、多租户、计费和分布式调度不在当前范围内。

如果这个项目对你有帮助，欢迎点一个 Star，让更多需要本地代理池的人看到它。

## 许可证

[MIT License](LICENSE)
