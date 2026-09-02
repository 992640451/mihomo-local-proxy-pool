# M4：自动化 API 与 CLI

M4 增加 `/api/v1`、带作用域的 API 令牌、OpenAPI 合同和 `ppm` 自动化命令。
这是功能里程碑，不修改当前应用的发布版本。

## 创建与撤销令牌

先配置管理认证，在浏览器登录后打开「系统设置 → API 令牌」。为每个脚本单独创建令牌，
立即保存只显示一次的密钥，然后清除显示。名称最长 80 字符，有效期 1–365 天，默认 90 天；
最多 100 个有效令牌。权限不可原地扩大，需要新建并撤销旧令牌。

| 权限 | 允许的操作 |
| --- | --- |
| `read` | 运行状态、脱敏诊断、订阅列表/节点目录、端口列表/策略组状态、OpenAPI |
| `subscriptions:write` | 包含只读；导入、更新、删除、刷新订阅 |
| `ports:write` | 包含只读；创建/替换、删除、主动验证端口池 |
| 两种管理权限同时授予 | 还可导出含凭据的加密配置、预检并应用恢复 |

令牌不能管理其他令牌、清理审计或调用未开放的界面接口；跨域写请求仍受 Origin 检查约束。
配置备份中含有订阅地址和节点凭据，即使使用口令加密，也按完整管理权限保护。
这三种权限是全实例范围，不是按单个订阅/端口隔离。订阅写权限可能触发核心重载并影响引用它的端口。

服务端仅存 SHA-256 摘要，数据库默认在订阅/会话持久目录的 `api-tokens.sqlite`，
也可使用 `API_TOKEN_DB` 指定。若没有持久目录，默认为内存，重启后令牌失效。
Docker 和便携版默认持久化。更改管理账号、密码哈希或 `AUTH_SESSION_VERSION` 后，旧令牌失效。
撤销阻止后续请求，不取消已经获得授权的在途操作。最近使用时间记录成功认证，最多每分钟落盘一次，
即使随后因作用域不足被拒绝也会更新；审计操作者显示 `api/<令牌 ID>`，不记录密钥。
令牌记录最多保留 900 条非活跃历史（创建时清理），加上至多 100 条活跃记录。

## CLI 快速使用

便携版使用 `./ppm`（Windows 为 `.\ppm.cmd`），源码版也可用 `node scripts/launcher.mjs`。
自动化命令仅连接服务，不会启动服务、创建便携配置或改变现有 `.env`。

将密钥写入仅自己可读的文件，通过进程环境指定其路径；不要写进 Git、命令行参数或 CI 日志。
也支持 `PPM_API_TOKEN` / `PPM_BACKUP_PASSWORD` 环境变量，CI 应使用平台的受保护 secret 注入。
文件方式优先，读取时仅去掉末尾一个换行；Unix 新建备份/计划文件权限为 `0600`，Windows 请同时限制目录 ACL。

```powershell
$env:PPM_API_URL = 'http://127.0.0.1:4173'
$env:PPM_API_TOKEN_FILE = 'C:\private\ppm-api-secret.txt'
$env:PPM_BACKUP_PASSWORD_FILE = 'C:\private\ppm-backup-password.txt'
.\ppm.cmd doctor
.\ppm.cmd ports list
.\ppm.cmd subscriptions refresh --all
.\ppm.cmd subscriptions refresh '<subscription-id>'
.\ppm.cmd backup 'backup-2026-09-02.json'
.\ppm.cmd restore 'backup-2026-09-02.json' --plan 'restore-plan.json'
# 审阅计划的 changes、missingNodes、unavailableNodes 和 errors 后再执行：
.\ppm.cmd restore 'backup-2026-09-02.json' --apply --plan 'restore-plan.json'
```

Linux/macOS 通过 `export PPM_API_TOKEN_FILE=/private/ppm-api-secret.txt` 等设置相同变量。
所有命令支持 `--url` 覆盖 `PPM_API_URL`，默认 `http://127.0.0.1:4173`；源码开发 API 通常为 4180。
远程必须为 HTTPS，HTTP 只允许 `127.0.0.1`、`localhost`、`[::1]`。地址可含部署前缀，但不能含账号密码、
查询或片段。CLI 拒绝重定向，不自动重试，单请求超时 120 秒。
保持服务默认的回环绑定；不要为了脚本访问直接公开管理端口。

输出为 JSON；成功退出 `0`，参数/文件/HTTP/认证错误退出 `1`，
诊断非正常、批量刷新部分失败或恢复预检不可应用退出 `2`。
`refresh --all` 只刷新启用的远程订阅，空集合成功；手动单订阅刷新不受启用状态限制。
若写操作超时，先查询状态，避免重复导入或重复执行恢复。
文件均独占创建，不覆盖已有备份/计划；重新预检请使用新文件名。

## 配置预检与恢复

复用既有 `ppm-recovery` v1 AES-256-GCM/scrypt 加密包；明文载荷上限 24 MiB，文件上限 33 MiB。
口令须为 8–256 字符。包含订阅、快照、节点原始配置/凭据和端口池；
不包含管理认证、会话、API 令牌、审计、检测历史/调度设置、主机路径或容器网络设置。
因此恢复配置不会恢复旧令牌，也不会迁移目标机器的端口发布范围。

1. `POST /api/v1/config/export` 导出加密包。
2. `POST /api/v1/config/plan` 解密验证，返回订阅/节点/端口的新增、修改、删除 ID 和不变数量。
   `missingNodes` 表示目标端口引用不存在的节点，阻止应用；`unavailableNodes` 提醒引用孤立节点或停用订阅。
   端口范围、协议、策略和节点数量使用与实际恢复相同的验证器。预检不写配置、不重载核心。
3. `POST /api/v1/config/apply` 必须携带预检的 `planToken` 和同一恢复包/口令。
   签名计划绑定包内容、当前完整配置摘要和 10 分钟有效期；服务重启后失效。
   期间刷新订阅、修改端口或改变包内容会返回 `409 CONFIGURATION_PLAN_STALE`，必须重新预检。

配置操作使用互斥租约，并暂停订阅调度读取一致快照；手动写入、订阅后台刷新及核心重载、
观测任务还在运行时会返回 `409 CONFIGURATION_BUSY`。预检不会终止这些任务。
直接在应用外修改数据库/文件不受应用锁保护，请停止服务后维护。
应用是**整体替换**，恢复包未包含的资源会删除。应用或核心重载失败时尝试回滚原配置；
数据库和核心不构成分布式事务，若错误报告回滚失败，需要人工检查，不应盲目重试。
预检不能保证外部核心运行状态、磁盘空间或网络可用性。

界面同样使用上述预检流程；明细较多时每类最多显示前 100 个 ID，CLI 返回完整明细。
`modified` 比较完整持久资源，包括订阅快照和刷新元数据，因此一次刷新也可能显示修改。

## API 合同与兼容性

登录后打开 `/api/v1/openapi.json`，或携带 `Authorization: Bearer <令牌>` 获取 JSON。
合同遵循 [OpenAPI 3.1.1](https://spec.openapis.org/oas/v3.1.1.html)；源码与路由共同维护在
`server/automation/contract.mjs`，路由只为显式列表创建 v1 别名。没有匿名 OpenAPI 或匿名 v1 API。
当前冻结 18 个操作；请求使用合同的 JSON Schema 校验，响应允许增加字段，调用方应忽略未知字段。
每个操作的 `x-required-scopes` 是需要同时满足的权限，不是 OAuth 登录流程。

```text
GET    /api/v1/runtime
GET    /api/v1/diagnostics
GET    /api/v1/subscriptions/catalog
GET    /api/v1/subscriptions
POST   /api/v1/subscriptions
PATCH  /api/v1/subscriptions/{id}
DELETE /api/v1/subscriptions/{id}
POST   /api/v1/subscriptions/{id}/refresh
POST   /api/v1/subscriptions/refresh-all
GET    /api/v1/ports
PUT    /api/v1/ports/{port}
DELETE /api/v1/ports/{port}
GET    /api/v1/ports/{port}/status
POST   /api/v1/ports/{port}/verify
POST   /api/v1/config/export
POST   /api/v1/config/plan
POST   /api/v1/config/apply
GET    /api/v1/openapi.json
```

错误保持 `{ "error": { "code", "message", "requestId", "detail"?, "meta"? } }`。
常见状态：401 无效令牌；403 权限不足；404 未开放路由；409 配置繁忙/计划失效；
413 请求过大；429 主动检测频率限制；501 当前运行模式不支持该操作。
节点目录/订阅列表不含原始节点凭据；主机名、节点名、订阅名、端口等仍属于管理信息，不要公开返回内容。
配置导出/恢复要求 native/hybrid 订阅存储和内置核心；不支持的模式返回结构化错误。

既有未版本化 `/api/...` 保留给浏览器会话及兼容客户端，不承诺为新脚本提供稳定合同，
不接受 API 令牌。旧 `/api/recovery/restore` 会话接口仍保留；新脚本和界面使用带计划保护的 config API。
v1 不自动开放可观测性调度写接口、任意端口 TCP 探测或令牌管理。
未来破坏性变更使用新的主 API 版本，不删除或重解释此合同现有字段。

## 验证

`npm test` 覆盖令牌摘要/过期/撤销/重启、完整作用域矩阵、Origin 防护、响应 Schema、
恢复差异和过期计划、失败回滚、CLI 独占文件与重定向拒绝。
浏览器隔离检查可使用 `node tests/helpers/observability-preview.mjs --auth`，
测试账号 `preview-admin` / `synthetic-preview-password` 仅用于该临时实例，退出时删除自身临时目录。
该实例不读取 `.env`，不操作真实订阅或端口。不要把测试账号用于部署。
