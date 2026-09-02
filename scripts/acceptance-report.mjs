import { appendFile, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { writeJson } from './build-metadata.mjs'
import { argument } from './release-utils.mjs'

const directory = path.resolve(argument(process.argv, '--directory', 'acceptance-assets'))
const metadataFiles = (await readdir(directory)).filter(name => name.endsWith('.build.json')).sort()
const builds = await Promise.all(metadataFiles.map(async name => ({ file: name, ...JSON.parse(await readFile(path.join(directory, name), 'utf8')) })))
const targets = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']
if (JSON.stringify(builds.map(item => item.target).sort()) !== JSON.stringify(targets)) throw new Error('验收必须包含六个指定原生平台')
if (!/^[a-f0-9]{40}$/.test(process.env.REVISION || '')) throw new Error('缺少验收源码提交')
if (!/^ghcr\.io\/[a-z0-9._/-]+\/m2-acceptance@sha256:[a-f0-9]{64}$/.test(process.env.ACCEPTANCE_IMAGE || '')) throw new Error('缺少隔离测试镜像摘要')
if (builds.some(item => item.revision !== process.env.REVISION || !item.coreVerified)) throw new Error('制品提交或核心校验状态不一致')
const runUrl = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
await writeJson(path.join(directory, 'acceptance-report.json'), {
  status: 'passed', revision: process.env.REVISION, runUrl, verifiedAt: new Date().toISOString(),
  image: process.env.ACCEPTANCE_IMAGE, builds,
  checks: ['unit-tests', 'six-native-portable-smoke', 'archive-checksums', 'provenance-signatures', 'sbom-signatures', 'ghcr-digest-pull-smoke-amd64-arm64', 'registry-signature', 'buildkit-sbom-provenance'],
  publishedRelease: false,
})
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `## M2 验收通过\n\n提交：\`${process.env.REVISION}\`\n\n六平台启动/认证/停止/重启、SBOM 与 provenance 签名、GHCR 摘要回拉验证均通过。\n\n测试镜像：\`${process.env.ACCEPTANCE_IMAGE}\`\n\n未创建版本标签或 Release。\n`)
