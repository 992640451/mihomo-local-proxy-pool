# 架构与演进约定

本文记录 Proxy Port Manager 的模块边界和兼容性约定，供功能开发、数据库变更和 Pull Request 审查使用。

## 运行边界

- `server/index.mjs` 只负责创建运行依赖、装配中间件和管理进程生命周期。
- `server/routes/` 按认证、订阅、端口和系统状态拆分 HTTP 路由。
- `server/http/` 提供请求上下文和统一响应，不承载业务规则。
- `server/security/` 提供可复用的安全边界；返回错误、写日志或生成诊断数据前必须先脱敏。
- `server/database/` 提供数据库版本迁移；存储模块只声明自己的有序迁移。
- `src/api.js` 是浏览器端 API 边界，负责请求发送和错误响应兼容。
- `src/components/` 保存跨页面通用展示组件，`src/pages/` 保存页面级组件，`src/hooks/` 保存可复用状态逻辑。

## 数据库迁移

订阅库和会话库使用 SQLite `PRAGMA user_version` 记录结构版本。迁移必须遵守：

1. 版本从 1 开始连续递增，不得修改已发布迁移。
2. 每次迁移在单个 `BEGIN IMMEDIATE` 事务中运行。
3. 升级已有数据库前，程序会执行 WAL checkpoint，并在数据库同目录生成带旧版本号和时间戳的备份。
4. 迁移失败必须回滚，且不得推进 `user_version`。
5. 新迁移需包含新建数据库、从上一版本升级、失败回滚和数据保留测试。
6. 程序遇到高于自身支持版本的数据库时应拒绝启动，避免旧程序破坏新数据。

迁移备份只用于升级失败时的紧急回退，不能替代后续提供的完整备份与恢复功能。

## API 错误契约

成功响应保持各资源原有结构。失败响应统一为：

```json
{
  "error": {
    "code": "SUBSCRIPTION_REFRESH_FAILED",
    "message": "订阅刷新失败",
    "detail": "已脱敏的可操作诊断信息",
    "requestId": "c534f90b-7a9b-4c15-8905-e88a477db736",
    "meta": {}
  }
}
```

- `code` 是供程序判断的稳定标识。
- `message` 是面向用户的稳定描述。
- `detail` 和 `meta` 可省略，且必须经过脱敏。
- 每个请求返回 `X-Request-Id`；安全格式的客户端请求 ID 会被透传，否则由服务端生成。
- 不得在错误中返回订阅原文、完整订阅 URL、节点凭据、认证 Cookie、控制器密钥或用户主目录。

## 修改检查

涉及应用或服务端代码时，至少执行：

```bash
npm test
npm run build
docker compose --env-file .env.example config --quiet
npm run docker:update
```

数据库、错误响应或安全边界变化还应增加相应的升级和泄密回归测试。
