import { readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { extractChangelogSection } from './release-utils.mjs'
import { compareVersions } from '../server/updates/manifest.mjs'

export const RELEASE_FILES = ['package.json', 'package-lock.json', 'compose.yaml', 'CHANGELOG.md', 'CHANGELOG_EN.md', 'release/update-policy.json', 'release/plan.json']
export const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).trim()
const json = value => JSON.stringify(value, null, 2) + '\n'
const stable = value => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) && value.split('.').every(n => Number.isSafeInteger(Number(n)))

export function nextVersion(current, bump) {
  if (!stable(current)) throw new Error('网页发布仅支持从正式版本递增')
  const index = { patch: 2, minor: 1, major: 0 }[bump]
  if (!Number.isInteger(index)) throw new Error('请选择 patch、minor 或 major')
  const parts = current.split('.').map(Number)
  parts[index]++
  for (let i = index + 1; i < 3; i++) parts[i] = 0
  const result = parts.join('.')
  if (!stable(result)) throw new Error('版本号超出有效范围')
  return result
}

export function validatePolicy(policy, target) {
  if (!policy || !stable(policy.minVersion) || !stable(policy.maxVersion) ||
      compareVersions(policy.minVersion, policy.maxVersion) > 0 || compareVersions(policy.maxVersion, target) >= 0) {
    throw new Error('升级来源范围必须有效且早于目标版本')
  }
}

export function promoteChangelog(content, language, version, date, commits) {
  const text = content.replaceAll('\r\n', '\n')
  const label = language === 'zh' ? '未发布' : 'Unreleased'
  if (text.includes(`## [${version}]`)) throw new Error(`变更记录已包含 ${version}`)
  const heading = new RegExp(`^## \\[${label}\\][ \\t]*$`, 'm').exec(text)
  if (!heading) throw new Error(`缺少 ${label} 章节`)
  const start = heading.index + heading[0].length
  const end = /^## /m.exec(text.slice(start))
  const boundary = end ? start + end.index : text.length
  let notes = text.slice(start, boundary).trim()
  // Existing editorial notes take priority. Commit titles are only a reviewable draft.
  if (!notes) {
    if (!commits.length) throw new Error('没有可生成发行说明的提交')
    const intro = language === 'zh' ? '### 变更摘要（提交记录草稿，请审核）' : '### Changes (commit-derived draft; review and translate as needed)'
    notes = `${intro}\n\n${commits.map(({ sha, subject }) => `- ${subject.replace(/[\r\n\u0000-\u001f]/g, ' ')} (${sha.slice(0, 7)})`).join('\n')}`
  }
  return `${text.slice(0, start)}\n\n## [${version}] - ${date}\n\n${notes}\n\n${text.slice(boundary)}`
}

export async function prepareRelease(root, { bump, upgrade = 'preserve', date = new Date().toISOString().slice(0, 10) } = {}) {
  if (git(root, 'status', '--porcelain')) throw new Error('请先提交工作区变更，再准备发布')
  const read = file => readFile(path.join(root, file), 'utf8')
  const pkg = JSON.parse(await read('package.json')), lock = JSON.parse(await read('package-lock.json'))
  const previousVersion = pkg.version, version = nextVersion(previousVersion, bump), tag = `v${version}`
  if (lock.version !== previousVersion || lock.packages?.['']?.version !== previousVersion) throw new Error('现有包与锁文件版本不一致')
  if (git(root, 'tag', '--list', tag)) throw new Error('目标标签已存在，请使用新版本')
  const baseSha = git(root, 'rev-parse', 'HEAD')
  const previousTag = `v${previousVersion}`
  git(root, 'merge-base', '--is-ancestor', previousTag, baseSha)
  const commits = git(root, 'log', '--format=%H%x09%s', `${previousTag}..HEAD`).split('\n').filter(Boolean).map(line => {
    const [sha, ...subject] = line.split('\t'); return { sha, subject: subject.join('\t') }
  })
  if (!commits.length) throw new Error('当前版本标签之后没有新提交')
  const compose = YAML.parseDocument(await read('compose.yaml'))
  if (compose.errors.length) throw new Error('Compose 无法解析')
  if (compose.getIn(['services', 'proxy-port-manager', 'image']) !== `proxy-port-manager:${previousVersion}`) throw new Error('Compose 应用镜像与现有版本不一致')
  compose.setIn(['services', 'proxy-port-manager', 'image'], `proxy-port-manager:${version}`)
  let policy = JSON.parse(await read('release/update-policy.json'))
  if (upgrade === 'current-tested') policy = { minVersion: previousVersion, maxVersion: previousVersion }
  else if (upgrade !== 'preserve') throw new Error('未知的升级兼容策略')
  validatePolicy(policy, version)
  pkg.version = lock.version = lock.packages[''].version = version
  const plan = { schemaVersion: 1, previousVersion, version, tag, baseSha, bump, upgrade, policy }
  const files = {
    'package.json': json(pkg), 'package-lock.json': json(lock), 'compose.yaml': compose.toString(),
    'CHANGELOG.md': promoteChangelog(await read('CHANGELOG.md'), 'zh', version, date, commits),
    'CHANGELOG_EN.md': promoteChangelog(await read('CHANGELOG_EN.md'), 'en', version, date, commits),
    'release/update-policy.json': json(policy), 'release/plan.json': json(plan),
  }
  // Validate every output before writing any file.
  for (const file of ['CHANGELOG.md', 'CHANGELOG_EN.md']) extractChangelogSection(files[file], version)
  for (const [file, content] of Object.entries(files)) await writeFile(path.join(root, file), content, 'utf8')
  return plan
}

export async function validateReleasePlan(root, plan) {
  if (plan?.schemaVersion !== 1 || !stable(plan.previousVersion) || !stable(plan.version) ||
      !/^[a-f0-9]{40}$/.test(plan.baseSha || '') || plan.tag !== `v${plan.version}` || nextVersion(plan.previousVersion, plan.bump) !== plan.version) throw new Error('发布计划无效')
  const read = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'))
  const pkg = await read('package.json'), lock = await read('package-lock.json'), policy = await read('release/update-policy.json')
  if (pkg.version !== plan.version || lock.version !== plan.version || lock.packages?.['']?.version !== plan.version) throw new Error('发布计划与包版本不一致')
  const compose = YAML.parse(await readFile(path.join(root, 'compose.yaml'), 'utf8'))
  if (compose.services?.['proxy-port-manager']?.image !== `proxy-port-manager:${plan.version}`) throw new Error('Compose 应用镜像版本不一致')
  validatePolicy(policy, plan.version)
  if (!['preserve', 'current-tested'].includes(plan.upgrade) || policy.minVersion !== plan.policy?.minVersion || policy.maxVersion !== plan.policy?.maxVersion) throw new Error('升级范围与发布计划不一致')
  const originalPolicy = JSON.parse(git(root, 'show', `${plan.baseSha}:release/update-policy.json`))
  const expectedPolicy = plan.upgrade === 'current-tested' ? { minVersion: plan.previousVersion, maxVersion: plan.previousVersion } : originalPolicy
  if (policy.minVersion !== expectedPolicy.minVersion || policy.maxVersion !== expectedPolicy.maxVersion) throw new Error('升级范围未经本次发布选择确认')
  if (JSON.parse(git(root, 'show', `${plan.baseSha}:package.json`)).version !== plan.previousVersion) throw new Error('发布基线版本不一致')
  git(root, 'merge-base', '--is-ancestor', plan.baseSha, 'HEAD')
  for (const file of ['CHANGELOG.md', 'CHANGELOG_EN.md']) extractChangelogSection(await readFile(path.join(root, file), 'utf8'), plan.version)
  return plan
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareRelease(process.cwd(), { bump: process.env.RELEASE_BUMP || process.argv[2], upgrade: process.env.RELEASE_UPGRADE || 'preserve' })
    .then(plan => console.log(`已准备 ${plan.tag}；请审核双语变更记录和升级来源 ${plan.policy.minVersion}–${plan.policy.maxVersion}`))
    .catch(error => { console.error(error.message); process.exitCode = 1 })
}
