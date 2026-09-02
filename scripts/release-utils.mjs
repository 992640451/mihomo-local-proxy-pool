import { readFile } from 'node:fs/promises'
import path from 'node:path'

const SEMVER_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

export function parseReleaseTag(tag) {
  const match = SEMVER_TAG.exec(String(tag || '').trim())
  if (!match) throw new Error(`无效的发布标签：${tag || '(空)'}；应使用 v1.2.3 或 v1.2.3-beta.1`)
  return { tag: match[0], version: match[0].slice(1), prerelease: Boolean(match[4]) }
}

export function extractChangelogSection(changelog, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const heading = new RegExp(`^## \\[${escaped}\\](?:\\s+-\\s+\\d{4}-\\d{2}-\\d{2})?\\s*$`, 'm')
  const match = heading.exec(changelog)
  if (!match) throw new Error(`CHANGELOG.md 中缺少 [${version}] 版本章节`)
  const start = match.index + match[0].length
  const remainder = changelog.slice(start)
  const nextHeading = /^##\s+/m.exec(remainder)
  const section = remainder.slice(0, nextHeading?.index ?? remainder.length).trim()
  if (!section) throw new Error(`CHANGELOG.md 的 [${version}] 版本章节为空`)
  return section
}

export async function readReleaseMetadata(root, tag) {
  const parsed = parseReleaseTag(tag)
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  if (packageJson.version !== parsed.version) {
    throw new Error(`版本不一致：标签为 ${parsed.tag}，package.json 为 ${packageJson.version}`)
  }
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'))
  if (lock.version !== parsed.version || lock.packages?.['']?.version !== parsed.version) throw new Error('package-lock.json 版本与标签不一致')
  const changelog = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8')
  return { ...parsed, notes: extractChangelogSection(changelog, parsed.version) }
}

export function portableMatrix(manifest) {
  const targets = [
    ['win32', 'windows', 'x64', 'windows-2025'], ['win32', 'windows', 'arm64', 'windows-11-arm'],
    ['linux', 'linux', 'x64', 'ubuntu-24.04'], ['linux', 'linux', 'arm64', 'ubuntu-24.04-arm'],
    ['darwin', 'macos', 'x64', 'macos-15-intel'], ['darwin', 'macos', 'arm64', 'macos-15'],
  ].filter(([platform, , arch]) => manifest.targets?.[`${platform}-${arch}`])
  if (!targets.length) throw new Error('Mihomo 清单没有可发布目标')
  for (const [platform, , arch] of targets) {
    if (!/^[a-f0-9]{64}$/.test(manifest.targets[`${platform}-${arch}`].sha256)) throw new Error('Mihomo 清单缺少有效 SHA256')
  }
  return { include: targets.map(([, platform, arch, runner]) => ({ platform, arch, runner })) }
}

export function argument(args, name, fallback = null) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}
