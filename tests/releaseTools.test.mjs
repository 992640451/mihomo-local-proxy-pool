import assert from 'node:assert/strict'
import test from 'node:test'
import { isMihomoExecutable } from '../scripts/fetch-mihomo.mjs'
import { extractChangelogSection, parseReleaseTag } from '../scripts/release-utils.mjs'

test('解析稳定版与预发布语义化标签', () => {
  assert.deepEqual(parseReleaseTag('v1.2.3'), { tag: 'v1.2.3', version: '1.2.3', prerelease: false })
  assert.deepEqual(parseReleaseTag('v2.0.0-beta.1'), { tag: 'v2.0.0-beta.1', version: '2.0.0-beta.1', prerelease: true })
  assert.throws(() => parseReleaseTag('1.2.3'), /无效的发布标签/)
  assert.throws(() => parseReleaseTag('v01.2.3'), /无效的发布标签/)
})

test('只提取指定版本的变更记录', () => {
  const changelog = '# 变更记录\n\n## [未发布]\n\n## [1.2.3] - 2026-09-02\n\n### 新增\n\n- 发布能力。\n\n## [1.2.2] - 2026-09-01\n\n- 旧内容。\n'
  assert.equal(extractChangelogSection(changelog, '1.2.3'), '### 新增\n\n- 发布能力。')
  assert.throws(() => extractChangelogSection(changelog, '9.9.9'), /缺少/)
})

test('Windows 解包只接受真正的 Mihomo 可执行文件', () => {
  assert.equal(isMihomoExecutable('mihomo-windows-amd64-v1.19.28.zip', 'win32'), false)
  assert.equal(isMihomoExecutable('mihomo-windows-amd64.exe', 'win32'), true)
})
