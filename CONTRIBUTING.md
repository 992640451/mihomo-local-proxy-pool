# 贡献指南

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

## Pull Request

- 一个 PR 只解决一个清晰问题。
- 新功能和缺陷修复应包含相应测试。
- 不要提交 `.env`、订阅 URL、节点凭据、数据库、生成配置或真实运行日志。
- UI 变更请附修改前后截图，并检查键盘操作、焦点和窄屏布局。
- 行为变化应同步更新 README 或 DOCKER 文档。
- PR 描述应包含动机、实现方式、验证结果和可能的兼容性影响。

## 报告问题

普通缺陷可以使用 Issue 模板。请提供操作系统、Node/Docker 版本、复现步骤和已脱敏日志。安全漏洞请遵循 [SECURITY.md](SECURITY.md)，不要公开披露。
