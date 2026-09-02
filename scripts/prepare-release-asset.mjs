import { access, appendFile, copyFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { argument, parseReleaseTag } from './release-utils.mjs'
import { smokePortable } from './smoke-portable.mjs'

async function exists(filename) {
  try { await access(filename); return true } catch { return false }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 执行失败：${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

async function main() {
  const sourceRoot = path.resolve(argument(process.argv, '--source-root', '.'))
  const output = path.resolve(argument(process.argv, '--output', 'release-assets'))
  const { version, tag } = parseReleaseTag(`v${argument(process.argv, '--version', '').replace(/^v/, '')}`)
  const platform = argument(process.argv, '--platform')
  const arch = argument(process.argv, '--arch')
  if (!platform || !arch) throw new Error('必须指定 --platform 和 --arch')
  const extension = platform === 'windows' ? 'zip' : 'tar.gz'
  const buildRoot = path.join(sourceRoot, '.artifacts', 'portable')
  const legacyName = `proxy-port-manager-${platform}-${arch}`
  const versionedName = `proxy-port-manager-${tag}-${platform}-${arch}`
  const stageCandidates = [path.join(buildRoot, versionedName), path.join(buildRoot, legacyName)]
  const archiveCandidates = stageCandidates.map(value => `${value}.${extension}`)
  const stage = (await Promise.all(stageCandidates.map(exists))).findIndex(Boolean)
  const archive = (await Promise.all(archiveCandidates.map(exists))).findIndex(Boolean)
  if (stage < 0 || archive < 0) throw new Error(`没有找到 ${platform}-${arch} 的便携构建结果`)
  const stageRoot = stageCandidates[stage]
  const archiveFile = archiveCandidates[archive]

  const packaged = JSON.parse(await readFile(path.join(stageRoot, 'app', 'package.json'), 'utf8'))
  if (packaged.version !== version) throw new Error(`便携包版本错误：期望 ${version}，实际 ${packaged.version}`)
  const nodeExecutable = path.join(stageRoot, 'runtime', platform === 'windows' ? 'node.exe' : 'node')
  const coreExecutable = path.join(stageRoot, 'core', platform === 'windows' ? 'mihomo.exe' : 'mihomo')
  const nodeVersion = run(nodeExecutable, ['--version'], stageRoot)
  const coreVersion = run(coreExecutable, ['-v'], stageRoot)
  const help = run(nodeExecutable, [path.join(stageRoot, 'app', 'scripts', 'launcher.mjs'), '--help'], stageRoot)
  if (!help.includes('ppm start')) throw new Error('便携启动器冒烟测试失败')
  const metadata = JSON.parse(await readFile(`${archiveFile}.build.json`, 'utf8'))
  const sbom = JSON.parse(await readFile(`${archiveFile}.cdx.json`, 'utf8'))
  if (sbom.bomFormat !== 'CycloneDX') throw new Error('缺少有效的 CycloneDX SBOM')
  for (const component of ['node', 'mihomo', 'react', 'react-dom', 'express']) {
    if (!sbom.components?.some(item => item.name === component)) throw new Error(`SBOM 缺少 ${component}`)
  }
  if (metadata.version !== version || metadata.target !== `${({ windows: 'win32', macos: 'darwin', linux: 'linux' })[platform]}-${arch}`) throw new Error('构建元数据与目标不一致')
  if (process.argv.includes('--require-verified-core') && !metadata.coreVerified) throw new Error('公开发布必须使用清单校验的 Mihomo')
  await smokePortable(archiveFile, {
    expectedVersion: version,
    expectedRevision: metadata.revision,
    expectedMetadata: metadata,
    expectedSbom: sbom,
    requireMetadata: await exists(path.join(sourceRoot, 'server', 'runtime', 'buildInfo.mjs')),
  })

  await mkdir(output, { recursive: true })
  const destination = path.join(output, `${versionedName}.${extension}`)
  await copyFile(archiveFile, destination)
  for (const suffix of ['.cdx.json', '.build.json']) await copyFile(`${archiveFile}${suffix}`, `${destination}${suffix}`)
  const githubOutput = argument(process.argv, '--github-output', process.env.GITHUB_OUTPUT)
  if (githubOutput) await appendFile(githubOutput, `asset=${destination.replaceAll('\\', '/')}\nsbom=${destination.replaceAll('\\', '/')}.cdx.json\nmetadata=${destination.replaceAll('\\', '/')}.build.json\n`)
  console.log(`便携包验证通过：${path.basename(destination)}；${nodeVersion}；${coreVersion}`)
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
