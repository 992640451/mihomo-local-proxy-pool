import { access, appendFile, copyFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { argument, parseReleaseTag } from './release-utils.mjs'

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

  await mkdir(output, { recursive: true })
  const destination = path.join(output, `${versionedName}.${extension}`)
  await copyFile(archiveFile, destination)
  const githubOutput = argument(process.argv, '--github-output', process.env.GITHUB_OUTPUT)
  if (githubOutput) await appendFile(githubOutput, `asset=${destination.replaceAll('\\', '/')}\n`)
  console.log(`便携包验证通过：${path.basename(destination)}；${nodeVersion}；${coreVersion}`)
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
