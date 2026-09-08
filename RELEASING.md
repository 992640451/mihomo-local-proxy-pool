# 发布工程

简体中文 · [English](RELEASING_EN.md)

本文以 **1.3.0** 为例。M2 是发布工程的路线图阶段名，不是应用版本。版本准备、本地提交、推送标签和公开 Release 是不同步骤；更新版本号并不代表已发布。后续发布使用新的语义化版本，不覆盖已有公开版本。

当前源码版本以 `package.json` 为准。下文命令中的 **1.3.0** 是历史示例，手动执行时替换为目标版本；网页流程自动计算版本，无需修改本手册。接入与恢复流程见 [中文升级指南](docs/UPDATING.md) / [English](docs/UPDATING_EN.md)。

## 网页准备与发布（推荐）

首次启用：将这套工作流合并到仓库默认分支。在 GitHub 的 Settings → Actions → General → Workflow permissions 中允许 **Allow GitHub Actions to create and approve pull requests**（这里只创建 PR，不自动批准或合并）。组织策略也必须允许；沿用仓库的 `UPDATE_SIGNING_PRIVATE_KEY`，无需新增个人访问令牌。分支/标签规则须允许机器人创建 `codex/release-v*` 分支和 `v*` 标签。

1. 先把要发布的功能合并到默认分支。打开 Actions → **准备新版本** → Run workflow，分支选择默认分支。
2. 选择 `patch`（修复）、`minor`（新功能）或 `major`（不兼容变更）。从 1.3.0 出发分别得到 1.3.1、1.4.0 或 2.0.0。
3. 升级范围默认 `preserve`，保留原有声明；如果已经完成“当前源码版本 → 目标版本”的实际升级测试，可选择 `current-tested`，将来源范围限定为当前版本。保留旧范围可能导致当前用户无法网页直升，请在 PR 中核对；版本递增不能代替兼容测试。
4. 工作流同步包与锁文件、Compose 应用镜像、两份 CHANGELOG 和 `release/plan.json`，运行测试、构建和签名预检，再创建发布 PR。已有“未发布”内容会原样归入新版本；为空时使用自上个标签以来的提交标题生成草稿，英文说明需要审核翻译。
5. 从工作流 Summary 点击 PR，审核 Files changed、升级范围与 CI。可以在 GitHub 网页编辑发行说明。准备期间请暂缓合并其他 PR；默认分支有新变化时，应关闭发布 PR、删除它的分支，再重新准备。
6. CI 通过后使用 **Squash and merge**（推荐）或 **Create a merge commit** 合并。不要使用 Rebase and merge；合并是本次公开发布的确认操作，不要让另一个使用内置令牌的工作流自动合并。
7. **合并发布 PR 后发布** 核对准确合并提交并再次验证，创建版本标签，显式触发现有 **Release**。全部六平台构建、双架构容器测试、签名与校验通过后才公开 Release。发起工作流或创建 PR 都不等于已发布。

流程使用 GitHub 内置令牌。机器人事件可能不自动运行普通 CI，或显示需要批准的工作流；准备流程会显式触发 CI，若 PR 仍显示 Approve workflows to run，可在网页批准。标签也通过显式 `workflow_dispatch` 衔接发布，避免依赖令牌创建标签后的 push 事件。

重复点击相同版本不会覆盖发布分支中的人工修改，会复用同一基线、同一选项的开放 PR。已有不同版本的发布 PR 时先完成或关闭它。签名未配置、权限不足或测试失败时，打开失败步骤修复原因，再点击 Re-run failed jobs；若 PR 已创建但 CI 调度失败，重跑会复用它。目标版本/标签已存在时不会移动或覆盖。标签创建后调度失败可以重跑衔接任务；Release 内部失败仍按本文“失败与重试”处理，不要重建已推送镜像。

当前源版本、API 主版本和 Mihomo 核心版本独立；网页准备不自动升级核心。发布说明和历史文档无需机械替换版本号。下面保留手动发布与工程排查命令。

## 发布前准备

1. 在同一提交中更新 `package.json`、`package-lock.json` 顶层与 `packages[""]` 版本、`compose.yaml` 管理服务镜像标签，以及 `CHANGELOG.md` / `CHANGELOG_EN.md` 的对应非空版本章节。功能或操作方式变化时同步双语 README 和指南，README 无需填写应用版本号；API v1 合同版本不随应用次版本自动变化。
2. 等待 CI 通过：单元/集成测试、Web 构建、Docker 启停测试，以及 Windows/Linux x64 最终便携包测试。
3. 核对 `release/core-manifest.json`：每个目标必须来自同一个 Mihomo 版本并有 SHA-256。升级核心时也同步 Compose 的核心版本和订阅 User-Agent。
4. 核对 Release 工作流的 Node 版本与 Dockerfile。Windows/Linux/macOS 均支持 x64 和 arm64；在原生 runner 构建，不交叉复制宿主 Node。
5. 仓库 Actions 必须允许发布 Packages 和生成 attestations。首次发布后检查 GHCR package 是否公开且关联本仓库。现有同名 package 如未授予仓库访问权限，`GITHUB_TOKEN` 可能无法推送。

### 更新签名预检

正式稳定版发布前，将 `release/update-public-keys.json` 对应的私钥配置为仓库 Actions Secret `UPDATE_SIGNING_PRIVATE_KEY`。不要每次发布都生成新密钥。工作流在推送镜像前校验签名密钥、公钥和来源版本范围；缺失或不匹配时停止发布。

本地仅验证，不输出私钥：

```text
node scripts/validate-update-signing.mjs --root . --key-file .local/update-signing/<密钥编号>.pem
npm run release:validate -- --tag v1.3.0
```

最终 `update-manifest.json` 与归档、元数据和校验和一并发布。原有版本需按升级指南完成首次接入；网页更新只接受更高的正式版本及内置信任公钥签名的清单。

## 触发与权限

- 推送 `v*` 标签自动触发 Release。标签必须符合 `vX.Y.Z` 或 `vX.Y.Z-beta.1` 格式，并与包、锁文件、Compose 和双语变更记录一致；全部验证通过后自动推送 GHCR 并公开 Release，无需再点击 Run workflow。
- 普通分支推送不触发 Release；删除标签时跳过发布流程。相同标签的自动与手动运行共用并发分组，不会相互取消正在运行的发布。
- 手动运行时，`publish=false` 默认只创建/更新 Draft，**不会登录或推送 GHCR**，但会生成 GitHub 构建证明并保存 CI artifacts。
- 手动运行并选择 `publish=true` 也会在验证通过后发布镜像和 Release。预发布标签保持 prerelease，不强制抢占 latest；公开版本继续受防覆盖检查保护。
- 本地运行构建和验证脚本不会发布任何东西。不要把 `.env` 或真实订阅放入构建上下文。

工作流使用内置 `GITHUB_TOKEN`，按 job 声明 `contents: write`、`packages: write`、`id-token: write` 和 `attestations: write` 等所需权限，无需额外填写个人 Token。仓库或组织策略必须允许这些操作；已有 GHCR package 需授权本仓库访问，供用户直接下载的包需检查公开可见性。

普通 CI 和独立 M2 Acceptance 流程的触发规则保持不变。新标签必须指向包含此自动发布配置的提交，历史标签仍使用其原有工作流。自动发布采用标签对应的发布工具和应用源码，后续构建固定到已校验的源码 SHA。

### 推送标签自动发布

以下命令中的 `v1.3.0` 仅为格式示例，实际操作必须替换为与源码版本一致、尚未发布的新标签。版本准备应已提交，工作区应干净，`HEAD` 必须是要发布的提交。

**PowerShell / CMD / Bash / Zsh 通用，在源码目录执行：**

```text
git status --short
npm run release:validate -- --tag v1.3.0
git push origin main
```

等待目标提交的 CI 通过，再创建并推送标签：

```text
git tag -a v1.3.0 -m "发布 1.3.0"
git push origin v1.3.0
git ls-remote --tags origin refs/tags/v1.3.0
```

推送后，在 [Actions → Release](https://github.com/992640451/mihomo-local-proxy-pool/actions/workflows/release.yml) 查看自动运行。流程会重新执行测试，构建并验证便携包与容器，生成校验和、SBOM、构建证明和发行说明，最后上传镜像并公开 Release。版本号和变更记录仍由维护者准备，流程不会自动提交代码或创建版本标签。

如果标签由另一个 Actions 工作流使用 `GITHUB_TOKEN` 推送，GitHub 不会因此再触发 `push` 工作流；此类上游自动化应显式调用 `workflow_dispatch` 并传入 `tag` 和 `publish=true`。维护者从本地推送标签可直接触发。参见 [GitHub 触发规则](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)。

### 手动草稿与补发

仅对已存在、尚未公开且没有自动发布正在运行的标签使用手动入口。推送新版本标签会自动公开发布，随后运行 `publish=false` 不会将其改成草稿模式，也不会取消已启动的自动发布。

在 Actions → Release → Run workflow 中选择包含发布配置的分支（通常为 `main`），填写已存在的标签，保持 `publish` 不勾选以构建草稿。也可使用已登录的 GitHub CLI（以下命令在 PowerShell / CMD / Bash / Zsh 中通用）：

```text
gh workflow run release.yml --repo 992640451/mihomo-local-proxy-pool --ref main -f tag=v1.3.0 -f publish=false
```

审核草稿后，以相同标签重新运行并设置 `publish=true`（或在网页勾选）。这会重新执行验证与构建，通过后推送 GHCR 并公开 Release；不要只在 Release 页面点击发布草稿来代替该流程，否则不会执行镜像发布。

`tag` 输入框**不会创建标签**。填写尚未推送的标签会在 `actions/checkout` 阶段失败，后续构建跳过。裸版本 `1.3.0` 不是有效标签格式。已公开的标签会被防覆盖校验拒绝；不要移动旧标签来发布新代码。

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

1.3.0 Windows 包还包含三个中文双击入口及 `开始使用.txt` / `START_HERE.txt`。底层入口为 `bin/ppm.cmd`，Windows 包根目录不得含 `ppm.cmd` 或 Unix `ppm`；Linux/macOS 包保留根目录 `ppm`。Windows 归档测试将安装目录改为含中文、空格及特殊字符的路径，通过真实 `cmd.exe` 验证双击入口的首次密码、后台运行、重复启动、打开入口、停止与重启，自动化测试使用 `--no-open` 避免打开浏览器。发布前还应人工确认默认浏览器能正常打开。

容器发布到 `ghcr.io/<owner>/<repository>:vX.Y.Z` 和 `:sha-<完整源码SHA>`，包含 `linux/amd64` 与 `linux/arm64`、BuildKit SBOM、provenance 和 OCI 版本标签。镜像是管理服务，Mihomo 仍是 Compose 的独立服务。两架构均先以临时容器完成页面、登录、构建信息、停止和重启测试。最终组合镜像复用同一源码、锁文件与构建时间构建。

工作流拒绝覆盖已存在的版本和 SHA 镜像标签；GHCR 标签本身并非不可变存储，严格固定部署请使用 Release 中的 `image@sha256:…`。不生成移动的 `latest` 镜像标签。

## 本地验证

```bash
npm ci
npm test
npm run build
npm run release:validate -- --tag v1.3.0
npm run portable:package
node scripts/prepare-release-asset.mjs --source-root . --output .artifacts/verified --version 1.3.0 --platform windows --arch x64 --require-verified-core
node scripts/create-checksums.mjs --directory .artifacts/verified --expected 1
npm run docker:update
node scripts/smoke-container.mjs --image proxy-port-manager:1.3.0 --version 1.3.0
```

按实际版本及宿主平台调整参数；平台名为 `windows`、`linux`、`macos`。`portable:package` 要求 Web 构建已完成。`--core` 可供本地定制构建，但不标记为清单验证，公开发布门禁会拒绝该包。源码模式缺少 `build-info.json` 时显示“未注入”，不会把启动时间冒充构建时间。

本地 `release:validate` 不带 `--check-remote` 时只验证版本、变更记录和构建元数据，不要求标签已存在，也不确认远端是否已发布。Release 工作流才会额外校验真实标签与公开状态。

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
