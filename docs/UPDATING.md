# 网页版本更新

简体中文 · [English](UPDATING_EN.md)

支持更新后的标准 Windows/Linux/macOS 便携包，以及已接入独立 updater 的 Docker Compose 安装。页面仅提供发布源中更高的正式版本；测试版、未签名版本和不兼容版本不会直接安装。

## 日常更新

登录后，全局版本按钮显示当前版本；发现新版时弹出 Tip。同一版本一天最多提醒一次，可以稍后查看或忽略该版本。“系统设置 → 版本更新”始终保留入口。

查看更新内容后点击“更新并自动重启”。更新器下载校验完成后显示 5 秒倒计时，随后停止服务、建立完整数据恢复点、安装并启动新版本。代理连接可能短暂中断。页面自动重连，只有实际版本、数据库、订阅解密、核心和监听检查通过才显示成功。关闭浏览器不取消后台任务。

下载及倒计时阶段可以请求取消；停止服务以后继续完成安装或恢复。自动检查默认开启，可以在更新窗口关闭；手动检查保留。网络失败显示“暂时无法检查”，不影响正常代理。

## 便携版首次接入

从 1.3.0 起，便携包首次正常启动时自动登记独立更新器。1.2.0 及更早的公开版本没有网页更新入口，需先按原有方式停止服务并备份完整 `data` 与 `core`，将新版解压到新的可写目录，迁入原数据，再启动新版；不要同时启动旧副本。迁移核心配置与缓存时，保留新包自带的 Mihomo 可执行文件，不用旧文件覆盖它。

此后继续使用安装根目录原有启动入口。网页更新后的程序位于 `releases/<版本>`，启动器根据 `.ppm-updates/active-release.json` 选择版本；`data` 与原核心配置目录保留。不要单独移动这些目录。

自定义数据库、密钥文件位于登记数据目录之外，或数据路径重叠的安装不支持自动更新，应先整理部署路径或继续手工更新。

## Docker 首次接入

先更新源码并执行 `npm run docker:update`，确认两个服务正常。在原部署目录执行：

```text
npm run updates:setup-docker
```

使用额外 Compose 文件时，按原顺序传入：

```text
npm run updates:setup-docker -- --compose-file compose.yaml --compose-file compose.legacy.yaml
```

已在本机构建好可信更新器镜像时，可用 `--updater-image proxy-port-manager-updater:1` 复用该镜像，跳过构建及基础镜像联网检查。

脚本检查实际项目、容器和数据挂载，构建独立更新器，保留原卷与端口，将管理容器接入更新状态目录。只有 updater 接触 Docker socket；管理容器不获得该接口。更新器以 uid 1000 运行，并获得 socket 所需的组权限。

接入后的实际部署配置保存在 `.local/updater/control/deployment.compose.json`，其中可能包含密钥，整个 `.local` 已被 Git 忽略。后续操作使用脚本输出的原项目名，例如：

```text
docker compose -p proxy-port-manager -f .local/updater/control/deployment.compose.json ps
docker compose -p proxy-port-manager -f .local/updater/control/deployment.compose.json logs --tail 100 updater
```

不要直接用原始 Compose 模板覆盖受管部署：原模板不包含更新后固定的镜像及 updater 配置。`npm run docker:update` 用于源码开发，会保留已登记的更新器接入，并在网页更新尚未完成时拒绝重建。受管生产部署使用网页升级；`docker:watch` 适合尚未接入更新器的源码开发环境。没有接入 updater 时，页面只提示新版本及接入方法。

## 失败与恢复

下载失败时原服务继续运行。停止后备份失败会重新启动原服务；安装、迁移、启动或验证失败会恢复同一恢复点中的程序、密钥和数据。恢复失败会显示“需要人工恢复”，不会将连接超时误报为成功。

便携版在原目录执行（Windows）：

```text
.\bin\ppm.cmd recover-update
```

Linux/macOS：

```text
./ppm recover-update
```

Docker 首先停止常驻更新器，再单次恢复，避免两个执行器并发。下列项目名应使用接入脚本输出的实际值：

```text
docker compose -p proxy-port-manager -f .local/updater/control/deployment.compose.json stop updater
docker compose -p proxy-port-manager -f .local/updater/control/deployment.compose.json run --rm --no-deps updater node server/updates/worker.mjs --directory /updates --once --recover
docker compose -p proxy-port-manager -f .local/updater/control/deployment.compose.json up -d --no-deps updater
```

便携任务及恢复点在 `.ppm-updates`；Docker 任务状态在 `.local/updater/state`，权威任务和恢复点在 `.local/updater/control`。恢复点含完整密钥，按原设备数据保护。当前不自动删除旧恢复点，确认新版本稳定后再人工管理磁盘空间。

成功更新并产生新数据之后，不提供无提示的降级：恢复旧快照会丢失升级之后的变更。现有“加密配置备份”不是完整升级恢复点。不要删除持久卷，也不要执行 `docker compose down -v`。

## 发布者配置

1. `release/update-public-keys.json` 是随应用和更新器分发的受信任公钥。初次创建签名密钥可运行 `npm run updates:keygen`；私钥只写入被忽略的 `.local/update-signing`，不能提交。不要在每次发布时重新生成密钥。
2. 将对应私钥内容配置为仓库 Actions Secret `UPDATE_SIGNING_PRIVATE_KEY`。已有安装只有内置了对应公钥，才能接受该密钥签名的更新。密钥轮换应提前通过旧密钥签名的版本分发新公钥。
3. 发布新的版本号，并在 `release/update-policy.json` 明确声明经过升级测试的来源版本范围。目前登记的来源版本为 `1.2.0`，目标必须更高；当前源码版本未变化不代表已经发布了新版。
4. 正式发布工作流在推送镜像前预检签名密钥与版本范围，然后绑定六平台归档校验和、实际源码提交、应用镜像 digest 及配套 Mihomo digest，生成签名 `update-manifest.json` 并一并发布。签名密钥缺失或不匹配会阻止发布。预发布不进入稳定版更新渠道。
5. 清单协议当前为 1。独立更新器自身不随业务版本中途替换；需要新协议时先发布兼容接入流程。

完整设计背景见 [升级设计](UPGRADE_DESIGN.md)。
