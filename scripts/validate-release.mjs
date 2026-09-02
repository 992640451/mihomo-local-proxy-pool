import { appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { argument, readReleaseMetadata, portableMatrix } from './release-utils.mjs'
import { buildMetadata, capture } from './build-metadata.mjs'

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function main() {
  const root = path.resolve(argument(process.argv, '--root', scriptRoot))
  const tag = argument(process.argv, '--tag', process.env.GITHUB_REF_NAME)
  const metadata = await readReleaseMetadata(root, tag)
  const matrix = portableMatrix(JSON.parse(await readFile(path.join(root, 'release', 'core-manifest.json'), 'utf8')))
  const build = await buildMetadata(root)
  if (process.argv.includes('--check-remote')) {
    const tagRevision = capture('git', ['-C', root, 'rev-parse', '--verify', `refs/tags/${metadata.tag}^{commit}`])
    if (tagRevision !== build.revision) throw new Error('发布源码不是指定标签的提交')
    const repository = process.env.GITHUB_REPOSITORY
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '')) throw new Error('无效的发布仓库')
    const response = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${metadata.tag}`, {
      headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000),
    })
    if (response.status !== 404) {
      if (!response.ok) throw new Error(`无法确认已有 Release：HTTP ${response.status}`)
      if (!(await response.json()).draft) throw new Error('Release 已公开，拒绝重新构建或覆盖；请使用新版本标签')
    }
  }
  const output = argument(process.argv, '--github-output', process.env.GITHUB_OUTPUT)
  if (output) {
    await appendFile(output, `tag=${metadata.tag}\nversion=${metadata.version}\nprerelease=${metadata.prerelease}\nmatrix=${JSON.stringify(matrix)}\ncount=${matrix.include.length}\nrevision=${build.revision}\nbuilt-at=${build.builtAt}\n`)
  }
  console.log(`发布元数据有效：${metadata.tag}（${metadata.prerelease ? '预发布' : '稳定版'}）`)
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
