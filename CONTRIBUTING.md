# 贡献指南

简体中文 · [English](CONTRIBUTING_EN.md)

感谢你改进 Proxy Port Manager。提交变更前，请先确认问题与“单机、本地代理池”的项目定位一致。

## 开发环境

- Node.js 22 或更高版本
- Docker Engine / Docker Desktop with Compose

```bash
npm ci
npm test
npm run build
```

涉及 Mihomo 配置、端口映射或 Docker 的变更，还应运行：

```bash
docker compose config
docker build -t proxy-port-manager:dev .
```

每次本地代码修改完成后，运行以下命令更新正在运行的管理服务容器并等待健康检查通过：

```bash
npm run docker:update
```

连续开发时可以改为在独立终端保持 `npm run docker:watch` 运行，由 Compose 在相关文件变化后自动重建容器。

## Pull Request

- 一个 PR 只解决一个清晰问题。
- 新功能和缺陷修复应包含相应测试。
- 不要提交 `.env`、订阅 URL、节点凭据、数据库、生成配置或真实运行日志。
- UI 变更请附修改前后截图，并检查键盘操作、焦点和窄屏布局。
- 行为变化应同步更新中英文 README 和对应指南；不要只更新其中一种语言。保留已有文件名和互相切换链接。
- 发布准备须同步包版本、锁文件、Compose 镜像标签和双语变更记录；API 合同版本不随应用次版本自动变化。参见 [发布指南](RELEASING.md)。
- PR 描述应包含动机、实现方式、验证结果和可能的兼容性影响。

服务端路由、数据库结构或 API 错误响应的修改还应遵循 [架构与演进约定](docs/ARCHITECTURE.md)。数据库迁移必须追加新版本，不得改写已经发布的迁移。

## 报告问题

普通缺陷可以使用 Issue 模板。请提供操作系统、Node/Docker 版本、复现步骤和已脱敏日志。安全漏洞请遵循 [SECURITY.md](SECURITY.md)，不要公开披露。
