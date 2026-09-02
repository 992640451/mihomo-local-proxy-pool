# 发布指南

项目使用语义化 Git 标签驱动 GitHub Release。稳定版本使用 `v1.2.3`，预发布版本使用 `v1.2.3-beta.1`。

## 发布前检查

1. 更新 `package.json` 和 `package-lock.json` 中的版本。
2. 将面向用户的变化从 `CHANGELOG.md` 的“未发布”移动到对应版本章节。
3. 确认 `npm test`、`npm run build` 和容器构建通过。
4. 创建并推送指向待发布提交的标签。

标签、`package.json` 和 `CHANGELOG.md` 的版本必须一致，否则 Release 工作流会停止。

## 自动发布

推送符合 `v*.*.*` 的新标签后，GitHub Actions 会在 Windows x64、Linux x64、Linux ARM64、macOS Intel 和 macOS Apple Silicon 上构建便携包，生成 `SHA256SUMS.txt` 和制品证明，然后发布 GitHub Release。预发布标签不会成为 Latest。

已经发布的 Release 不允许被工作流覆盖。修复发布内容时应创建新版本，不要移动公开标签。

## 补发已有标签

在 GitHub Actions 中手动运行 **Release** 工作流并输入已有标签。默认只创建 Draft；检查发行说明、五个平台制品和校验文件后，再在 GitHub Release 页面发布。确需由工作流直接发布时，可以启用 `publish`。

## 本地校验

```bash
npm run release:validate -- --tag v1.0.0
npm run release:notes -- --tag v1.0.0 --output release-notes.md
```

便携包的文件名包含版本号。发布后的包内置固定版本 Node.js，并按 `release/core-manifest.json` 下载及校验 Mihomo。
