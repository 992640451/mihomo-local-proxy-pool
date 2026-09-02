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
  const changelog = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8')
  return { ...parsed, notes: extractChangelogSection(changelog, parsed.version) }
}

export function argument(args, name, fallback = null) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}
