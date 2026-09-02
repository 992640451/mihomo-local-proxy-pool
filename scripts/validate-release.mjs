import { appendFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { argument, readReleaseMetadata } from './release-utils.mjs'

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function main() {
  const root = path.resolve(argument(process.argv, '--root', scriptRoot))
  const tag = argument(process.argv, '--tag', process.env.GITHUB_REF_NAME)
  const metadata = await readReleaseMetadata(root, tag)
  const output = argument(process.argv, '--github-output', process.env.GITHUB_OUTPUT)
  if (output) {
    await appendFile(output, `tag=${metadata.tag}\nversion=${metadata.version}\nprerelease=${metadata.prerelease}\n`)
  }
  console.log(`发布元数据有效：${metadata.tag}（${metadata.prerelease ? '预发布' : '稳定版'}）`)
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
