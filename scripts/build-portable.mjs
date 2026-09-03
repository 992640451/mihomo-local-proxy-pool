import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fetchMihomo } from './fetch-mihomo.mjs'
import { tarCommand } from './archive-tools.mjs'
import { copyDocumentation } from './documentation-files.mjs'
import { copyPortableLaunchers } from './portable-launchers.mjs'
import { buildMetadata, capture, executableComponent, extendSbom, writeJson } from './build-metadata.mjs'

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : null
}

function targetName(version) {
  const platform = ({ win32: 'windows', darwin: 'macos', linux: 'linux' })[process.platform] || process.platform
  return `proxy-port-manager-v${version}-${platform}-${process.arch}`
}

function assertInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`构建目标不在允许目录内：${child}`)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false, ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} 执行失败，退出码 ${result.status}`)
}

async function isFile(filename) {
  try { return (await stat(filename)).isFile() } catch { return false }
}

async function main() {
  const projectRoot = path.resolve(argument('--root') || scriptRoot)
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'))
  const outputRoot = path.resolve(argument('--output') || path.join(projectRoot, '.artifacts', 'portable'))
  let coreSource = argument('--core') || process.env.PPM_MIHOMO_BINARY || ''
  let coreDownload = null
  if (!coreSource) {
    const fetched = await fetchMihomo({
      output: path.join(outputRoot, '.core-cache', process.platform === 'win32' ? 'mihomo.exe' : 'mihomo'),
      manifestFile: path.join(projectRoot, 'release', 'core-manifest.json'),
    })
    coreSource = fetched.outputFile
    coreDownload = fetched
  }
  coreSource = path.resolve(coreSource)
  if (!await isFile(coreSource)) throw new Error(`Mihomo 核心不存在：${coreSource}`)
  const name = targetName(packageJson.version)
  const stage = path.join(outputRoot, name)
  const archive = path.join(outputRoot, `${name}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`)
  assertInside(outputRoot, stage)
  assertInside(outputRoot, archive)
  await mkdir(outputRoot, { recursive: true })
  await rm(stage, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
  await rm(archive, { force: true, maxRetries: 8, retryDelay: 150 })
  await Promise.all([
    mkdir(path.join(stage, 'runtime'), { recursive: true }),
    mkdir(path.join(stage, 'core'), { recursive: true }),
    mkdir(path.join(stage, 'app'), { recursive: true }),
  ])

  const appFiles = ['server', 'shared', 'scripts', 'release', 'dist', 'package.json', 'package-lock.json']
  for (const value of appFiles) await cp(path.join(projectRoot, value), path.join(stage, 'app', value), { recursive: true })
  await copyDocumentation(projectRoot, stage)
  await copyPortableLaunchers(projectRoot, stage)
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
  const coreName = process.platform === 'win32' ? 'mihomo.exe' : 'mihomo'
  await cp(process.execPath, path.join(stage, 'runtime', nodeName))
  await cp(coreSource, path.join(stage, 'core', coreName))
  if (process.platform !== 'win32') {
    await Promise.all([
      import('node:fs/promises').then(({ chmod }) => chmod(path.join(stage, 'ppm'), 0o755)),
      import('node:fs/promises').then(({ chmod }) => chmod(path.join(stage, 'runtime', nodeName), 0o755)),
      import('node:fs/promises').then(({ chmod }) => chmod(path.join(stage, 'core', coreName), 0o755)),
    ])
  }

  const bundledNpmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const npmCli = process.env.npm_execpath || (await isFile(bundledNpmCli) ? bundledNpmCli : null)
  if (!npmCli) throw new Error('找不到 npm CLI；请从 npm 脚本运行 portable:build')
  run(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts'], { cwd: path.join(stage, 'app') })
  const metadata = await buildMetadata(projectRoot)
  const coreVersion = capture(coreSource, ['-v'])
  const versionMatch = /Mihomo\s+(?:Meta\s+)?v?([\d.]+)/i.exec(coreVersion)
  if (!versionMatch) throw new Error('无法识别 Mihomo 版本')
  if (coreDownload && coreDownload.version !== versionMatch[1]) throw new Error('Mihomo 实际版本与下载清单不一致')
  metadata.mihomoVersion = versionMatch[1]
  metadata.coreArchiveSha256 = coreDownload?.sha256 || null
  metadata.coreVerified = Boolean(coreDownload)
  await writeJson(path.join(stage, 'app', 'build-info.json'), metadata)
  // Include frontend dependencies and build tools as well as server dependencies.
  // Reading the installed graph avoids listing optional binaries for other platforms.
  const npmBom = JSON.parse(capture(process.execPath, [npmCli, 'sbom', '--sbom-format=cyclonedx'], { cwd: projectRoot }))
  const natives = await Promise.all([
    executableComponent('node', process.versions.node, path.join(stage, 'runtime', nodeName), `https://github.com/nodejs/node/tree/${process.version}`),
    executableComponent('mihomo', metadata.mihomoVersion, path.join(stage, 'core', coreName), `https://github.com/MetaCubeX/mihomo/tree/v${metadata.mihomoVersion}`),
  ])
  await writeJson(path.join(stage, 'sbom.cdx.json'), extendSbom(npmBom, metadata, natives))
  await writeJson(`${archive}.build.json`, metadata)
  await cp(path.join(stage, 'sbom.cdx.json'), `${archive}.cdx.json`)
  await rm(path.join(stage, 'app', 'node_modules', '.bin'), { recursive: true, force: true })
  if (process.platform === 'win32') run(tarCommand(), ['-a', '-cf', archive, '-C', outputRoot, name])
  else run(tarCommand(), ['-czf', archive, '-C', outputRoot, name])
  console.log(`便携包已生成：${archive}`)
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
