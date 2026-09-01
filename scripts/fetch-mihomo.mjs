import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function findExecutable(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, item.name)
    if (item.isDirectory()) {
      const nested = await findExecutable(filename)
      if (nested) return nested
    } else if (/^mihomo(?:-.*)?(?:\.exe)?$/i.test(item.name)) return filename
  }
  return null
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} 执行失败，退出码 ${result.status}`)
}

export async function fetchMihomo({
  output,
  platform = process.platform,
  arch = process.arch,
  manifestFile = path.join(projectRoot, 'release', 'core-manifest.json'),
} = {}) {
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  const target = manifest.targets?.[`${platform}-${arch}`]
  if (!target) throw new Error(`Mihomo 清单不支持当前目标：${platform}-${arch}`)
  const outputFile = path.resolve(output || path.join(projectRoot, '.artifacts', 'core', platform === 'win32' ? 'mihomo.exe' : 'mihomo'))
  const url = `https://github.com/MetaCubeX/mihomo/releases/download/v${manifest.version}/${target.archive}`
  console.log(`下载 Mihomo v${manifest.version}：${target.archive}`)
  const response = await fetch(url, { headers: { 'User-Agent': 'Proxy-Port-Manager-Build' } })
  if (!response.ok) throw new Error(`下载 Mihomo 失败：HTTP ${response.status}`)
  const archive = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(archive).digest('hex')
  if (digest !== target.sha256) throw new Error(`Mihomo SHA256 校验失败：期望 ${target.sha256}，实际 ${digest}`)
  await mkdir(path.dirname(outputFile), { recursive: true })
  if (target.archive.endsWith('.gz')) {
    await writeFile(outputFile, gunzipSync(archive), { mode: 0o755 })
  } else if (target.archive.endsWith('.zip')) {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'ppm-mihomo-'))
    try {
      const archiveFile = path.join(temporary, target.archive)
      await writeFile(archiveFile, archive)
      run(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xf', archiveFile, '-C', temporary])
      const executable = await findExecutable(temporary)
      if (!executable) throw new Error('Mihomo 压缩包中没有可执行文件')
      await writeFile(outputFile, await readFile(executable), { mode: 0o755 })
    } finally {
      await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  } else throw new Error(`不支持的 Mihomo 压缩格式：${target.archive}`)
  if (platform !== 'win32') await chmod(outputFile, 0o755)
  console.log(`Mihomo 已写入：${outputFile}`)
  return { outputFile, version: manifest.version, sha256: digest, target: `${platform}-${arch}` }
}

async function main() {
  const index = process.argv.indexOf('--output')
  const output = index >= 0 ? process.argv[index + 1] : undefined
  await fetchMihomo({ output })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
