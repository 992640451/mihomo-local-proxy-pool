<p align="center">
  <img src="assets/readme-hero.png" alt="Proxy Port Manager 本地代理池路由示意图" width="100%" />
</p>

<h1 align="center">Proxy Port Manager</h1>

<p align="center">
  面向本机应用的可视化 Mihomo 代理池管理器
</p>

<p align="center">
  <a href="https://github.com/992640451/mihomo-local-proxy-pool/actions/workflows/ci.yml"><img src="https://github.com/992640451/mihomo-local-proxy-pool/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-22d3ee.svg" alt="MIT License" /></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.1.0-f59e0b.svg" alt="Version 0.1.0" /></a>
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A522-f59e0b.svg" alt="Node.js 22 or newer" />
  <img src="https://img.shields.io/badge/scope-localhost-34d399.svg" alt="Localhost only" />
</p>

一个面向本机应用的可视化代理池管理器。它把 Mihomo 作为独立核心运行，将多个订阅节点组合成固定的 HTTP、SOCKS5 或 Mixed 端口，并提供轮询、主备切换、延迟优选和稳定哈希策略。

默认配置只向 `127.0.0.1` 发布管理页面和代理端口，不会开放到局域网或公网。

> 当前版本定位为单机、本地代理池。它不提供代理节点，也不面向公网或多租户部署。

## 导航

- [功能](#功能)
- [快速开始](#快速开始)
- [创建第一个轮询池](#创建第一个轮询池)
- [使用代理池](#使用代理池)
- [从 Clash Verge 迁移](#从-clash-verge-迁移)
- [数据、安全与隐私](#数据安全与隐私)
- [开发与验证](#开发与验证)
- [常见问题](#常见问题)
- [变更记录](CHANGELOG.md)

## 功能

- 导入 URL 或粘贴 Mihomo/Clash YAML，自动刷新并保留最后一个可用版本。
- 为一个本地端口选择多个节点，支持手动、主备、自动优选、稳定哈希和轮询。
- 定期健康检查，自动跳过不可用节点。
- 订阅、会话和端口池配置持久化，容器重建后仍可恢复。
- 通过浏览器管理端口池，并检测 Listener 和 Mihomo 核心状态。
- 可选迁移 Clash Verge 远程订阅，无需改变 Clash Verge 当前配置。

## 架构

```text
本机应用
  │ HTTP / SOCKS5
  ▼
127.0.0.1:17900 ──► Mihomo 策略组 ──► 健康订阅节点 ──► 互联网
                           ▲
                           │ 私有 Controller API
                           │
浏览器 ──► 127.0.0.1:4173 ──► Proxy Port Manager
```

## 快速开始

需要 Git、Node.js 22 或更高版本，以及 Docker Desktop 或 Docker Engine with Compose。Windows 用户应让 Docker Desktop 运行 Linux containers；Linux 用户需要确保当前账号有权运行 `docker`。

```bash
git --version
node --version
docker compose version
```

```bash
git clone https://github.com/992640451/mihomo-local-proxy-pool.git
cd mihomo-local-proxy-pool
npm run init
docker compose config
docker compose build --pull
docker compose up -d
```

`npm run init` 会生成 `.env`、随机控制器密钥和一次性显示的管理密码。保存终端里显示的密码，然后访问：

```text
http://127.0.0.1:4173
```

首次登录后，在“订阅”页面导入 Mihomo/Clash YAML URL 或粘贴 YAML，再到“代理端口”页面创建端口池。

检查运行状态：

```bash
docker compose ps
curl http://127.0.0.1:4173/healthz       # Linux/macOS
curl.exe http://127.0.0.1:4173/healthz   # Windows PowerShell
```

Compose 会一次发布 `17891-17893` 和 `17900-17999` 的完整端口范围。启动失败时，需要检查整个范围是否被其他程序占用，而不只是准备创建的单个端口。

## 创建第一个轮询池

1. 打开“订阅”，通过 URL 或粘贴 YAML 导入至少一个订阅。
2. 打开“代理端口”，点击“新建端口池”。
3. 输入 `17900`，协议选择 `Mixed`，使用方式选择“轮询均衡”。
4. 从节点目录选择至少两个节点；健康检查可先保留默认值。
5. 保存后服务会原子写入配置并热重载 Mihomo。
6. 等待一次健康检查，然后点击该端口右侧“检测”；显示“Listener 可连接”即表示入口可用。

自动策略只会使用通过健康检查的节点。所选节点不足两个、端口超出发布范围或节点已被订阅更新移除时，服务会拒绝保存并显示原因。

## 使用代理池

假设已经创建 Mixed 端口 `17900`：

```bash
# HTTP/HTTPS
curl --proxy http://127.0.0.1:17900 https://api.ipify.org       # Linux/macOS
curl.exe --proxy http://127.0.0.1:17900 https://api.ipify.org   # Windows

# SOCKS5，并由代理端解析域名
curl --proxy socks5h://127.0.0.1:17900 https://api.ipify.org
```

常见环境变量值如下；具体设置命令取决于 shell 或调用程序：

```text
HTTP_PROXY=http://127.0.0.1:17900
HTTPS_PROXY=http://127.0.0.1:17900
ALL_PROXY=socks5h://127.0.0.1:17900
```

轮询只对新连接生效；已建立的 TCP 连接不会在节点之间迁移。健康检查失败的节点会被跳过，因此实际参与轮询的节点数可能少于配置数量。

在代理端口页面点击“验证”，服务会顺序建立 8 个独立连接，并汇总成功率、唯一出口数量、出口 IP 命中次数和平均延迟。多个出口 IP 按近似均匀次数重复出现，说明出口轮换生效。不同节点也可能共用同一公网出口，因此“唯一出口为 1”不一定表示 Mihomo 没有切换节点；结合节点健康状态和 Mihomo 日志判断。该操作会访问配置的出口地理信息查询服务，请勿高频运行。

## 从 Clash Verge 迁移

新安装默认使用项目自己的订阅数据库，不依赖 Clash Verge。需要迁移现有 Clash Verge 远程订阅时，在 `.env` 中加入 Clash Verge 数据目录；下面的 `USERNAME` 必须替换为实际用户名：

```text
CATALOG_SOURCE=C:/Users/USERNAME/AppData/Roaming/io.github.clash-verge-rev.clash-verge-rev
```

Linux/macOS 的安装位置可能不同，请选择实际包含 `profiles.yaml` 和 `profiles/` 的 Clash Verge 配置目录。

然后使用迁移覆盖文件启动：

```bash
docker compose -f compose.yaml -f compose.legacy.yaml up -d --build
```

在订阅页面核对订阅数量、节点数量及刷新状态。重复启动迁移模式不会重复导入已有数据库。确认迁移成功后，必须同时完成以下两步：

1. 确保 `.env` 中 `SUBSCRIPTION_MODE=native`，或删除该项以使用默认值。
2. 停止使用 `compose.legacy.yaml`，只运行 `docker compose up -d`。

保留 Docker volumes。迁移覆盖文件会强制使用 `hybrid`，因此继续携带它启动就不会退出迁移模式。详细说明参见 [DOCKER.md](DOCKER.md)。

## 数据、安全与隐私

- `.env` 包含本机密钥且已被 Git 忽略，请勿提交或分享。
- 订阅 URL、原始 YAML 和节点敏感字段使用 AES-256-GCM 加密后写入 SQLite。
- 浏览器会话只保存随机令牌的 SHA-256 摘要。
- 默认 Compose 仅绑定 `127.0.0.1`。不要在没有额外访问控制的情况下改为 `0.0.0.0`。
- 本项目用于管理用户有权使用的代理订阅，不提供代理节点，也不授权绕过网络、服务或地区的使用政策。

持久化数据位于 Docker volumes：

- `proxy-session-data`：订阅数据库、登录会话和端口池状态。
- `proxy-mihomo-data`：生成的 Mihomo 配置及核心运行数据。生成配置包含节点连接字段，应视为敏感明文数据保护。

`docker compose down` 不会删除这些数据；只有显式添加 `-v` 才会删除 volumes。

## 开发与验证

```bash
npm ci
npm test
npm run build
npm run dev
```

提交前还应检查：

```bash
docker compose config
docker build -t proxy-port-manager:dev .
```

## 常见问题

### 代理端口可以连接，但没有切换出口

轮询针对“新连接”而不是同一连接里的多个请求。请关闭连接复用，或用多次独立 `curl` 进程验证；同时检查端口池中有多少节点通过健康检查。

### 端口没有监听

运行 `docker compose ps` 和 `docker compose logs mihomo-core`。确认端口位于 `17891-17893` 或 `17900-17999`，且没有被本机其他程序占用。

### 忘记管理密码

运行专用密码重置命令：

```bash
npm run init -- --reset-password
docker compose up -d --force-recreate proxy-port-manager
```

该命令只更新管理员 Salt、Scrypt Hash 和会话版本，不会更换 Mihomo 控制器及订阅加密密钥；已有浏览器会话会失效，订阅和端口池保持可用。不要使用 `--force` 重置密码：它会覆盖整个 `.env`、轮换加密密钥和其他自定义设置，使现有加密订阅无法解密。执行任何恢复操作前，建议同时安全备份原 `.env` 和 Docker volumes，且不要运行 `docker compose down -v`。

## 参与贡献

请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要提交包含订阅 URL、节点凭据、`.env` 或运行配置的公开 Issue。

## 项目状态

当前处于早期版本，定位为单机、本地使用的代理池。公开多用户代理、计费、分布式调度和公网部署不在当前范围内。

## 许可证

本项目采用 [MIT License](LICENSE)。允许个人和商业使用、修改及分发，但需要保留原版权和许可证声明。
