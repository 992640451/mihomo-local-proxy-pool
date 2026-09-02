# 发布工程

M2 是路线图阶段名，不是降级版本指令。当前待发布版本为 1.1.0；后续发布使用新的语义化版本，不覆盖已有公开版本。

## 发布前准备

1. 在同一提交中更新 `package.json`、`package-lock.json` 根版本，以及 `CHANGELOG.md` 的对应版本章节。
2. 等待 CI 通过：单元/集成测试、Web 构建、Docker 启停测试，以及 Windows/Linux x64 最终便携包测试。
3. 核对 `release/core-manifest.json`：每个目标必须来自同一个 Mihomo 版本并有 SHA-256。升级核心时也同步 Compose 的核心版本和订阅 User-Agent。
4. 核对 Release 工作流的 Node 版本与 Dockerfile。Windows/Linux/macOS 均支持 x64 和 arm64；在原生 runner 构建，不交叉复制宿主 Node。
5. 仓库 Actions 必须允许发布 Packages 和生成 attestations。首次发布后检查 GHCR package 是否公开且关联本仓库。现有同名 package 如未授予仓库访问权限，`GITHUB_TOKEN` 可能无法推送。

## 触发与权限

- Release 仅支持手动触发（`workflow_dispatch`）。推送包含此配置的版本标签不会启动 Release，也不会自动生成 Draft、推送 GHCR 或公开 Release。
- 推送版本标签后，在 Actions → Release → Run workflow 中选择包含最新发布配置的分支（通常为 `main`），并填写已存在的标签。只有标签、包和锁文件版本一致、变更记录非空且全部验证通过才生成制品。
- 手动运行时，`publish=false` 默认只创建/更新 Draft，**不会登录或推送 GHCR**，但会生成 GitHub 构建证明并保存 CI artifacts。
- 仅手动运行并显式选择 `publish=true` 才发布 GHCR 镜像并将 Release 从 Draft 转为公开。预发布标签保持 prerelease，不强制抢占 latest。
- 本地运行构建和验证脚本不会发布任何东西。不要把 `.env` 或真实订阅放入构建上下文。

普通 CI 和独立 M2 Acceptance 流程的触发规则保持不变。历史标签中的旧工作流及已有取消记录不会被本次修改重写；新版本标签应指向包含最新发布配置的提交。

手动运行采用所选工作流提交中的发布脚本，源码固定到指定标签的提交；两者可能不同。构建证明记录工作流来源，`.build.json` 记录实际应用源码 SHA。M2 全链路要求目标源码包含构建信息模块与对应 Dockerfile；更老标签请用其兼容版本的工作流，不要给历史二进制伪造新元数据。

## 流程与产物

### 不创建 Release 的 M2 验收

推送 `codex/m2-acceptance` 分支或手动运行 **M2 Acceptance**，使用当前提交而非版本标签完成六平台原生构建、启动与重启、制品 SHA-256、provenance 和 SBOM 签名反向验证。

此流程会写入独立 GHCR package `ghcr.io/<owner>/<repository>/m2-acceptance`，仅使用 `run-<run-id>-<attempt>` 测试标签；不会写正式镜像的版本/SHA/latest 标签，不创建 Git 标签或 GitHub Release。测试镜像会保留供审计，不自动删除。测试制品保留 7 天，最终验收证据保留 30 天。

验收必须把刚推送的镜像按 digest 拉回，分别启动 amd64/arm64；检查两架构的 BuildKit SPDX/SLSA 清单，并从 OCI registry 验证 GitHub 签名。最终 `verify` job 通过后才生成 `m2-acceptance-evidence`，内含准确的源码提交、六平台构建信息、镜像摘要和校验清单。没有这个成功结果，不能仅凭本地测试或旧 CI 宣称远程验收完成。

### 正式版本

`版本/标签校验 → 六平台便携构建与启停测试 → Linux 双架构容器测试 → GHCR → Release`

目标矩阵由源标签中的核心清单生成；缺少目标时不声称该架构已发布。每个平台生成：

- `proxy-port-manager-vX.Y.Z-<platform>-<arch>.zip` / `.tar.gz`。
- 同名 `.cdx.json`：CycloneDX SBOM，涵盖本平台安装的 npm 构建依赖图（包括 React 前端和构建工具），以及实际分发的 Node.js/Mihomo 二进制 SHA-256。不是完整的原生传递依赖清单，也不代表所有构建依赖都会在运行时加载。
- 同名 `.build.json`：应用版本、源码提交、构建时间（UTC）、目标、Node/Mihomo 版本和核心归档校验信息。
- 汇总 `SHA256SUMS.txt`：同时覆盖归档、SBOM、构建元数据。
- GitHub provenance attestation；另以 SBOM attestation 将每份 SBOM 绑定到对应归档摘要。

归档内部也有 `sbom.cdx.json` 和 `app/build-info.json`。测试解压最终归档，确认内部文件与 sidecar 一致，然后使用内置 Node/Mihomo 完成首次初始化、Web 页面、认证、核心健康、停止及再次启动。测试不导入真实订阅、不对公网发代理探测；使用独立临时目录和端口，结束后清理。

容器发布到 `ghcr.io/<owner>/<repository>:vX.Y.Z` 和 `:sha-<完整源码SHA>`，包含 `linux/amd64` 与 `linux/arm64`、BuildKit SBOM、provenance 和 OCI 版本标签。镜像是管理服务，Mihomo 仍是 Compose 的独立服务。两架构均先以临时容器完成页面、登录、构建信息、停止和重启测试。最终组合镜像复用同一源码、锁文件与构建时间构建。

工作流拒绝覆盖已存在的版本和 SHA 镜像标签；GHCR 标签本身并非不可变存储，严格固定部署请使用 Release 中的 `image@sha256:…`。不生成移动的 `latest` 镜像标签。

## 本地验证

```bash
npm ci
npm test
npm run build
npm run release:validate -- --tag v1.1.0
npm run portable:package
node scripts/prepare-release-asset.mjs --source-root . --output .artifacts/verified --version 1.1.0 --platform windows --arch x64 --require-verified-core
node scripts/create-checksums.mjs --directory .artifacts/verified --expected 1
npm run docker:update
node scripts/smoke-container.mjs --image proxy-port-manager:1.1.0 --version 1.1.0
```

按实际版本及宿主平台调整参数；平台名为 `windows`、`linux`、`macos`。`portable:package` 要求 Web 构建已完成。`--core` 可供本地定制构建，但不标记为清单验证，公开发布门禁会拒绝该包。源码模式缺少 `build-info.json` 时显示“未注入”，不会把启动时间冒充构建时间。

## 校验下载与使用镜像

```bash
sha256sum -c SHA256SUMS.txt
gh attestation verify <下载的归档> --repo <owner>/<repository>
gh attestation verify <下载的归档> --repo <owner>/<repository> --predicate-type https://cyclonedx.org/bom
```

Windows 可使用 `Get-FileHash -Algorithm SHA256 <归档>` 与清单逐项比对；没有下载全部文件时，只校验自己下载的对应条目。

使用预构建镜像时，给现有 Compose 的管理服务设置 `image: ghcr.io/<owner>/<repository>@sha256:<摘要>`，再运行 `docker compose up -d --no-build --pull always`。保留原有 `.env`、volumes、端口和安全设置；不要单独启动没有 Mihomo 的管理服务来代替完整部署。

## 失败与重试

- 核心校验、SBOM、测试或架构构建失败会阻断公开发布，不能绕过门禁直接补上传。
- GitHub Release 和 GHCR 没有跨服务事务：镜像推送成功、Release 步骤失败时，已推送镜像仍会保留。不要删除重推已分发的镜像。
- 此时优先在同一次 Actions run 中选择 **Re-run failed jobs**；若只有 release job 失败，可复用成功的 container job。若 container job 在推送后失败，重试会被防覆盖检查阻止，需人工核验或使用新版本。
- 如必须完全重建，使用新版本标签。已公开 Release 不能通过本流程覆盖；Draft 可以替换验证产物。
- 未在当前机器运行的平台由 GitHub 原生 runner 验证；本地通过不等于远程六平台发布已通过。

## 实现参考

GitHub [runner 支持矩阵](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)、[artifact attestations](https://github.com/actions/attest)、Docker [build-push-action](https://github.com/docker/build-push-action)、npm [SBOM 命令](https://docs.npmjs.com/cli/v11/commands/npm-sbom/)。
