# Docker 部署

简体中文 · [English](DOCKER.md)

生产环境在 `127.0.0.1:4173` 提供 React 页面和 Express API，并运行独立的 Mihomo 配套容器。代理监听仅发布到本机 TCP/UDP 范围 `127.0.0.1:17891-17893` 和 `127.0.0.1:17900-17999`；`17894` 不在默认发布范围内。

## 启动

1. 运行 `npm run init`，生成 `.env` 和仅在初始化时显示的管理密码。
2. 运行 `docker compose config`。
3. 运行 `docker compose build --pull`。
4. 运行 `docker compose up -d`。
5. 检查 `http://127.0.0.1:4173/healthz`。

API 根据原生订阅数据库中选定的节点生成 `/mihomo/config.yaml`。两个容器共享 `proxy-mihomo-data` 卷，API 通过私有 Controller 热重载 Mihomo。

## 原生订阅存储

应用负责订阅导入与刷新，新安装默认使用 `native` 模式。导入既有 Clash Verge 远程订阅时，设置 `SUBSCRIPTION_MODE=hybrid` 和 `CATALOG_SOURCE`，使用 `docker compose -f compose.yaml -f compose.legacy.yaml up -d` 启动。迁移写入 `/data/subscriptions.sqlite`，保留既有端口引用的旧节点 ID。订阅 URL、YAML 快照和单节点配置使用 `SUBSCRIPTION_MASTER_KEY` 进行 AES-256-GCM 加密；Compose 默认复用较长的 Mihomo Controller 密钥。

在「订阅」页预览并导入 Mihomo/Clash YAML URL 或粘贴的 YAML。刷新成功后以事务化流程激活；下载或校验失败时记录错误，保留最后可用快照。节点按协议与端点身份匹配，因此改名和列表重排不会破坏端口引用。服务端在浏览器关闭后仍执行刷新计划，并在变更后重新生成和热重载内置 Mihomo 配置。

订阅下载拒绝私有、回环及保留地址。若主机使用 Mihomo/Clash Fake-IP DNS，服务端会识别默认 Fake-IP 范围，通过 DNS-over-HTTPS 获取真实 A/AAAA 记录，验证后将连接固定到已验证地址。默认 DoH 服务为 Cloudflare 和 Google；可通过逗号分隔的 `SUBSCRIPTION_DOH_URLS` 覆盖，并用 `SUBSCRIPTION_DOH_TIMEOUT_MS` 设置单次查询超时。自定义端点必须使用 HTTPS。不要仅为解决 Fake-IP 开启 `SUBSCRIPTION_ALLOW_PRIVATE_NETWORKS`，这会完全关闭目标地址安全检查。

订阅支持修改名称、启用状态、刷新间隔、替换 URL 和 `-10000` 到 `10000` 的整数优先级；优先级越大越靠前。订阅页、节点定义、节点页及端口池的订阅选择器使用相同的服务端排序。旧数据库在启动时自动添加优先级列。

确认迁移结果后，在 `.env` 中改回 `SUBSCRIPTION_MODE=native`，恢复使用普通 `docker compose up -d`。原生模式不再运行时读取 Clash Verge 文件；保留已经包含 `subscriptions.sqlite` 和 `sessions.sqlite` 的 `/data` 卷。

## 可靠性、备份与诊断

「操作记录」读取 `/data/audit.sqlite` 中已持久化、脱敏的事件。`AUDIT_RETENTION_DAYS` 默认 30 天，`AUDIT_MAX_EVENTS` 默认 10000 条。审计属于运行历史，不包含在配置恢复包中。

「系统设置」可以生成口令加密的 JSON 恢复包，包含订阅、重新加密为可迁移形式的源数据、稳定节点 ID 和端口池。不包含登录会话、审计、管理凭据、API 令牌、检测历史和检测调度设置。恢复必须先审阅差异，再于 10 分钟内显式应用签名计划；配置发生变化后计划失效。恢复是整体替换，包中缺少的资源会被删除，但不会修改容器端口映射。应用或核心重载失败时尝试回滚；如回滚也失败，应检查错误及实际状态，不要盲目重试。

同一页面检查订阅、会话、API 令牌、审计和检测数据库、两类调度器、Mihomo Controller、目录一致性及可写存储。可下载的诊断文件会脱敏，但公开到 Issue 前仍应自行复核。

使用 Cookie 认证的浏览器变更请求受同源检查保护。若反向代理确实需要不同的浏览器来源，请在 `APP_ALLOWED_ORIGINS` 中以逗号分隔方式明确列出，不要使用通配符。

订阅管理接口（均使用已有登录会话保护）：

- `GET /api/subscriptions`
- `POST /api/subscriptions/preview`
- `POST /api/subscriptions`
- `PATCH /api/subscriptions/:id`
- `POST /api/subscriptions/:id/refresh`
- `POST /api/subscriptions/refresh-all`
- `DELETE /api/subscriptions/:id`

创建对应监听后，主机应用可使用 `http://127.0.0.1:17900`。容器中的 `127.0.0.1` 指容器自身；发布到主机回环地址的端口不是通用的跨容器入口，不应假设 `host.docker.internal` 一定能访问。跨项目容器访问需专门设计私有网络及访问控制，不要仅为连通容器就把主机端口开放到 `0.0.0.0`。

## 可观测性与自动化

1.2.0 增加节点延迟测试、端口历史和 24 小时失败趋势。后台检测默认关闭，设置及历史保存在 `/data/observability.sqlite`；主动检测通过代理访问配置的测试服务。流量限制与隐私说明见 [可观测性](OBSERVABILITY.md)。

在「系统设置 → API 令牌」创建令牌，其摘要保存在 `/data/api-tokens.sqlite`。使用 `/api/v1`，或从源码目录/便携包运行 CLI，并在主机上将 `PPM_API_URL` 指向 `http://127.0.0.1:4173`。容器镜像不包含启动器。权限、凭据文件、备份与恢复预检见 [自动化指南](AUTOMATION.md)。

## 更新与停止

升级前备份数据。完整数据目录备份应先停止服务以保持一致；加密配置导出不包含所有数据库。保留 `.env` 及两个命名卷。

```bash
git pull --ff-only
npm run docker:update
docker compose ps
# 停止但不删除数据：
docker compose down
```

`docker:update` 只重建并替换管理服务容器，等待健康检查，保留 Mihomo 容器与数据卷。持续开发时在单独终端保持 `npm run docker:watch` 运行。除非确实要删除持久化数据，否则不要使用 `docker compose down -v`。按摘要固定 GHCR 镜像部署见 [发布工程](RELEASING.md)。

## 持久化登录会话

会话存储在 `/data/sessions.sqlite`。Compose 将命名卷 `proxy-session-data` 挂载到 `/data`，有效登录可跨应用、容器和主机重启保留。普通 `docker compose down` 和重建保留该卷；删除该卷会使所有会话失效。

端口配置保存在 `/data/embedded-core.json`，生成的 Mihomo 配置和核心运行数据保存在独立 `proxy-mihomo-data` 卷。普通 `docker compose down` 保留两个卷。

## 端口池策略

每个托管监听指向独立的 Mihomo 策略组。界面和 API 支持：

- `select`：固定/手动选定节点。
- `fallback`：按配置顺序使用第一个健康节点。
- `url-test`：周期性选择较低延迟节点。
- `consistent-hashing`：尽量让相同目标使用相同健康节点。
- `round-robin`：将新连接轮换到健康节点。

自动策略至少需要两个节点。健康检查 URL、间隔、超时、最大失败次数和延迟优选容差在写配置前由 API 校验。策略变更以原子文件写入并通过私有 Controller 热重载。活动节点切换不会迁移已有 TCP 连接，新连接使用新选择。

端口状态使用结构版本 2，保存有序 `nodeIds`、策略和健康检查选项。旧 `nodeId` 字段保留为主节点别名，便于回退兼容。首次从版本 1 升级时保留 `/data/embedded-core.json.v1.bak`，并把旧端口转换为单节点 `select` 组。

`GET /api/ports/:port/status` 返回内置 Mihomo Controller 提供的活动节点与各节点健康状态，需要与其他管理接口相同的登录会话。

数据库存储随机会话令牌的 SHA-256 摘要，而不是可直接使用的令牌。`AUTH_SESSION_IDLE_SECONDS` 控制空闲过期，`AUTH_SESSION_MAX_SECONDS` 控制绝对有效期，`AUTH_SESSION_TOUCH_SECONDS` 限制活动时间落盘频率。增加 `AUTH_SESSION_VERSION` 可在不改密码的情况下使旧会话失效。

### 记住登录

登录页默认勾选“记住密码”。服务端不保存明文密码，而是签发随机 HttpOnly 会话 Cookie，默认最长 30 天。退出登录、凭据版本变化或到期后失效。不勾选时签发浏览器会话 Cookie；关闭窗口后是否保留还可能受浏览器会话恢复行为影响。

长期会话使用 `AUTH_REMEMBER_IDLE_SECONDS` / `AUTH_REMEMBER_MAX_SECONDS`，普通会话使用 `AUTH_SESSION_IDLE_SECONDS` / `AUTH_SESSION_MAX_SECONDS`。更改管理凭据或 `AUTH_SESSION_VERSION` 也会使已有 API 令牌失效。
