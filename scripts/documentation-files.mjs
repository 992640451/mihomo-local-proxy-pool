import { cp, mkdir } from 'node:fs/promises'
import path from 'node:path'

// Preserve existing public filenames; each pair is [Chinese, English].
export const DOCUMENTATION_PAIRS = [
  ['README.md', 'README_EN.md'],
  ['DOCKER_ZH.md', 'DOCKER.md'],
  ['PORTABLE_ZH.md', 'PORTABLE.md'],
  ['OBSERVABILITY.md', 'OBSERVABILITY_EN.md'],
  ['AUTOMATION.md', 'AUTOMATION_EN.md'],
  ['RELEASING.md', 'RELEASING_EN.md'],
  ['CHANGELOG.md', 'CHANGELOG_EN.md'],
  ['CONTRIBUTING.md', 'CONTRIBUTING_EN.md'],
  ['SECURITY.md', 'SECURITY_EN.md'],
  ['docs/ARCHITECTURE.md', 'docs/ARCHITECTURE_EN.md'],
  ['docs/UPDATING.md', 'docs/UPDATING_EN.md'],
  ['THIRD_PARTY_NOTICES_ZH.md', 'THIRD_PARTY_NOTICES.md'],
]

// An explicit allowlist excludes local QA notes, user data and credentials.
export const DOCUMENTATION_FILES = [
  ...DOCUMENTATION_PAIRS.flat(),
  '开始使用.txt',
  'START_HERE.txt',
  'LICENSE',
  'assets/readme-hero.png',
  'docs/UPGRADE_DESIGN.md',
]

export async function copyDocumentation(sourceRoot, destinationRoot) {
  for (const file of DOCUMENTATION_FILES) {
    const destination = path.join(destinationRoot, file)
    await mkdir(path.dirname(destination), { recursive: true })
    await cp(path.join(sourceRoot, file), destination)
  }
}
