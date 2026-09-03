import { spawnSync } from "node:child_process";
import path from "node:path";
import { readJson, writeJson } from "../server/updates/files.mjs";

const compose = ["compose"];
const service = "proxy-port-manager";
const healthUrl = process.env.DOCKER_HEALTH_URL || "http://127.0.0.1:4173/healthz";
const timeoutMs = Number(process.env.DOCKER_UPDATE_TIMEOUT_MS || 90_000);

function runDocker(args, options = {}) {
  const result = spawnSync("docker", [...compose, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.capture) {
      process.stderr.write(result.stdout || "");
      process.stderr.write(result.stderr || "");
    }
    throw new Error(`docker compose ${args.join(" ")} 执行失败`);
  }
  return options.capture ? result.stdout.trim() : "";
}

async function waitForHealth() {
  const deadline = Date.now() + timeoutMs;
  let lastError = "服务尚未就绪";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) return await response.text();
      lastError = `健康检查返回 HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`等待 ${healthUrl} 超时：${lastError}`);
}

try {
  const managedFile = path.resolve('.local/updater/control/deployment.compose.json');
  const registration = await readJson(path.resolve('.local/updater/control/deployment.json'));
  const managed = registration ? await readJson(managedFile) : null;
  let sourceConfig;
  if (managed) {
    if (await readJson(path.resolve('.local/updater/state/pending.json'))) throw new Error('网页更新或恢复任务尚未完成，请完成该任务后再更新开发容器');
    sourceConfig = JSON.parse(runDocker(['config', '--format', 'json'], { capture: true }));
    if (managed.name !== sourceConfig.name || registration.project !== sourceConfig.name) throw new Error('更新器登记与当前 Compose 项目不一致');
  }
  console.log(`[docker:update] 构建 ${service} 镜像…`);
  runDocker(["build", service]);

  if (managed) {
    const image = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', sourceConfig.services[service].image], { encoding: 'utf8' });
    if (image.status !== 0 || !/^sha256:[a-f0-9]{64}$/.test(image.stdout?.trim())) throw new Error('无法确认新构建的镜像');
    managed.services[service].image = image.stdout.trim();
    await writeJson(managedFile, managed);
    compose.push('-p', managed.name, '-f', managedFile);
    console.log('[docker:update] 保留现有网页更新器和数据卷接入。');
  }

  console.log(`[docker:update] 使用新镜像重建 ${service} 容器…`);
  runDocker([
    "up",
    "-d",
    "--no-deps",
    "--force-recreate",
    "--wait",
    "--wait-timeout",
    String(Math.ceil(timeoutMs / 1_000)),
    service,
  ]);

  console.log(`[docker:update] 等待 ${healthUrl}…`);
  const health = await waitForHealth();
  const containerId = runDocker(["ps", "-q", service], { capture: true });
  const imageId = spawnSync(
    "docker",
    ["inspect", "--format", "{{.Image}}", containerId],
    { encoding: "utf8" },
  ).stdout?.trim();

  console.log(`[docker:update] 更新完成，健康检查通过：${health}`);
  if (containerId) console.log(`[docker:update] container=${containerId.slice(0, 12)} image=${imageId?.slice(7, 19) || "unknown"}`);
  runDocker(["ps", service]);
} catch (error) {
  console.error(`[docker:update] ${error.message}`);
  try {
    runDocker(["logs", "--tail", "80", service]);
  } catch {
    // Preserve the original update error when diagnostics are unavailable.
  }
  process.exitCode = 1;
}
