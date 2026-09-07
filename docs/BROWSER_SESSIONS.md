# 会话轮换使用指南

会话轮换适用于一个浏览器配置文件独占一个代理端口：本次使用保持同一节点，结束后再次开始按节点顺序轮换。受管内置 Mihomo 的 Docker 和便携部署支持此功能；外部 Clash Verge 模式暂不支持。

## 在页面中使用

1. 新建或修改端口，选择“会话轮换”，至少选择两个节点。可通过节点排序决定轮换顺序。
2. 保存后点击“开始使用”，等待页面显示“本次节点已固定”，再打开使用该代理端口的浏览器。
3. 本次使用中的新连接、跨网站访问和空闲不会触发轮换。
4. 关闭浏览器配置文件后点击“结束使用”。下次点击“开始使用”会分配下一个可用节点。

没有开始会话的端口拒绝代理流量，因此浏览器的代理预检也应放在开始会话之后。活跃会话中节点故障会连接失败，不自动换点，也不回退直连。没有不同于上次节点的可用节点时，开始操作会明确失败。

后台定时检测跳过会话端口；手动“验证”检查活动会话的连通性，不消耗轮询位置。修改/删除使用中的端口以及激活会改变当前节点的订阅更新会被阻止，请先结束使用。

## 在网页中自动启动 Roxy

1. 在 Roxy 的“API → API 配置”中开启本地 API，并复制 API Key。
2. 打开管理器“系统设置 → 浏览器接入”，填写 API 端口（默认 `50000`）和 API Key，点击“测试并连接”。API Key 加密保存，后续测试可留空。
3. 新建或修改“会话轮换”端口，在“Roxy 浏览器窗口”中直接选择团队、项目和窗口。管理器通过 Roxy 接口自动读取 ID；只有自动读取失败时才需要展开高级区域手动填写。
4. 默认开启“启动前同步代理”，管理器会把所选窗口代理设置为 `127.0.0.1:端口`。
5. 保存后，在端口卡片点击“启动 Roxy · 窗口名”。管理器先固定节点，再同步代理并打开窗口。关闭窗口后会自动结束会话，下次启动轮换到另一个可用节点。

Docker 部署会在服务端自动使用 `host.docker.internal` 访问 Windows 上的 Roxy；页面中仍只填写 Roxy 显示的本地 API 端口。Roxy 与管理器需要运行在同一台电脑。直接使用 Roxy 原生“打开”按钮不会提前建立代理会话，应从管理器端口卡片启动。

## 命令行启动器与普通浏览器

普通浏览器以及需要脚本集成的场景仍可使用命令行启动器。它先创建会话、确认节点，再打开程序；正常退出后结束会话。

1. 在管理器“系统设置”创建具有 `ports:write` 权限的 API 令牌，将令牌单独保存到本机私有文件。
2. 复制 [Roxy 示例](examples/session-roxy.json) 或 [Chromium 示例](examples/session-chromium.json) 到自己的本机配置文件，填写端口、配置文件标识和启动信息。不要把密钥写入这个配置文件。
3. 在浏览器所在主机运行以下 PowerShell 命令。源码使用 `node scripts/launcher.mjs`；便携包使用 `bin/ppm.cmd`。

```powershell
$env:PPM_API_URL = 'http://127.0.0.1:4173'
$env:PPM_API_TOKEN_FILE = 'C:\Private\ppm-token.txt'
$env:ROXY_API_KEY_FILE = 'C:\Private\roxy-key.txt'
node scripts/launcher.mjs launch 'C:\Private\browser-session.json'
```

命令行 Roxy 适配仍需要在配置文件中提供实际 `workspaceId` 和 `dirId`；日常使用建议采用上面的网页绑定。启动器读取窗口运行状态，关闭窗口后约一秒内结束会话；快速重开时应等待上一启动命令输出 `ended`。再次执行启动命令时，已运行的同一配置文件会返回 `already-running`，保持节点。

Roxy 适配使用官方的 `browser/open` 和 `browser/connection_info` 接口。接口和账号能力以安装版本为准，参见 [Roxy 官方文档](https://roxybrowser.cn/docs/api-documentation/api-endpoint.html)。原生“打开”按钮没有接入本启动流程，直接使用它不会自动创建新会话。

普通程序的 `command` 适配以启动进程退出作为结束信号，要求程序独立运行，不能把启动请求转交给已有进程。Chromium 示例使用独立用户目录并关闭后台模式；同一目录只能从这个入口启动。其他程序应核实进程生命周期；不能保证时使用页面手动开始/结束。

启动器需要持续运行以观察退出。其失联、浏览器状态不确定或启动 API 超时时保留会话绑定，不猜测浏览器已经退出。再次使用前，在页面核对会话状态，确认浏览器关闭，再结束旧会话。

Docker 用户在宿主机运行启动命令，不在容器内启动 Roxy。管理器的 API 令牌与 Roxy API Key 分别使用，均不通过命令行参数传入。

## 通用 API 与 CLI

```powershell
node scripts/launcher.mjs ports session 17900
node scripts/launcher.mjs ports start 17900 'my-launch-0001' 'profile-17900'
node scripts/launcher.mjs ports end 17900 '实际返回的-sessionId'
```

开始请求使用唯一 `launchId`，8–128 个字母、数字或 `._:-` 字符。同一次请求的重试必须复用该标识；下一次使用必须换一个新标识。相同标识和配置文件返回同一次结果，即使该会话已经结束，也不会再次选点。只有 `state: active` 才可启动浏览器；CLI 开始操作返回其他状态时退出码为 2。

查询返回 `state`、`session` 和上次分配的节点 ID。`active` 是持久化的会话状态，不代表节点当前一定健康。结束请求必须携带准确 `sessionId`，重复调用幂等，旧结束请求不影响新会话。

## 重启和异常恢复

会话单独持久化在 `proxy-sessions.sqlite`，默认与内置核心状态文件同目录，也可通过 `PROXY_SESSION_DB` 指定。它不属于管理后台登录会话，也不包含节点密码。应用或核心重启后继续使用原节点；配置生成始终将此策略组限定为单个绑定节点。

Roxy API Key 与窗口绑定保存在同目录的 `browser-integrations.sqlite`（可通过 `BROWSER_INTEGRATION_DB` 指定），API Key 使用持久主密钥加密。需要单独密钥时设置至少 16 个字符且保持不变的 `BROWSER_INTEGRATION_MASTER_KEY`；已有数据写入后更换密钥会导致原 API Key 无法解密。该数据库和密钥不包含在配置恢复包中。做完整部署备份时必须同时保存数据库和对应主密钥：Docker 需另存 `.env`，便携版需保留包含 `config.env` 的完整 `data` 目录。

默认支持的 Roxy 路径仅限同一电脑：便携版访问回环地址，Docker 访问宿主机网关。`ROXY_API_HOST` 是高级网络覆盖，Roxy API Key 会随 HTTP 请求发送；不得将它指向不可信网络或公网地址，也不要通过端口转发暴露 Roxy API。

中断的开始/结束操作显示“需要结束并重新开始”。确认浏览器关闭后点击“结束使用”，完成清理后才能开始下一会话。配置恢复期间不允许存在未结束的代理会话；恢复包只包含策略配置，不携带活动代理会话。

固定节点并不保证公网 IP 恒定：上游节点可能自行更换出口，不同节点也可能共用出口。需要严格固定 IP 时，应使用满足要求的上游资源。

## 开发验证

```powershell
npm test
npm run build
node tests/proxySessionCore.integration.mjs 'C:\Path\mihomo.exe'
```

真实核心集成测试使用隔离的临时配置和本地合成上游，不会读取或更改部署中的订阅和端口。
