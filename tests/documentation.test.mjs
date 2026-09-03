import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import YAML from 'yaml'
import { copyDocumentation, DOCUMENTATION_FILES, DOCUMENTATION_PAIRS } from '../scripts/documentation-files.mjs'
import { extractChangelogSection, readReleaseMetadata } from '../scripts/release-utils.mjs'
import { API_OPERATIONS } from '../server/automation/contract.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = file => readFile(path.join(root, file), 'utf8')
const prose = text => text.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '')

function links(text) {
  const content = prose(text)
  return [
    ...[...content.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)].map(match => match[1]),
    ...[...content.matchAll(/(?:href|src)="([^"]+)"/g)].map(match => match[1]),
  ]
}

function headingIds(text) {
  const counts = new Map()
  return [...prose(text).matchAll(/^#{1,6}\s+(.+)$/gm)].map(match => {
    const slug = match[1].toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/ /g, '-')
    const count = counts.get(slug) || 0
    counts.set(slug, count + 1)
    return count ? `${slug}-${count}` : slug
  })
}

test('公开指南具有双语互链，两个 README 都能找到全部指南', async () => {
  const indexes = await Promise.all(['README.md', 'README_EN.md'].map(read))
  for (const pair of DOCUMENTATION_PAIRS) {
    for (const [index, file] of pair.entries()) {
      const other = path.relative(path.dirname(file), pair[1 - index]).replaceAll('\\', '/')
      assert.ok(links(await read(file)).includes(other), `${file} missing translation link ${other}`)
      if (file.startsWith('README')) continue
      for (const content of indexes) assert.ok(links(content).includes(file), `README missing ${file}`)
    }
  }
})

test('公开文档的本地链接和 README 锚点可解析', async () => {
  for (const file of DOCUMENTATION_PAIRS.flat()) {
    const content = await read(file)
    for (const link of links(content)) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(link)) continue
      const [pathname, fragment] = link.split('#')
      const target = pathname ? path.resolve(root, path.dirname(file), decodeURIComponent(pathname)) : path.join(root, file)
      const relative = path.relative(root, target)
      assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), `${file}: link outside repository`)
      const targetContent = await readFile(target)
      if (fragment && target.endsWith('.md')) {
        assert.ok(headingIds(targetContent.toString('utf8')).includes(decodeURIComponent(fragment)), `${file}: missing anchor ${link}`)
      }
    }
  }
})

test('应用、锁文件、Compose 和双语变更记录版本一致', async () => {
  const version = JSON.parse(await read('package.json')).version
  await readReleaseMetadata(root, `v${version}`)
  const compose = YAML.parse(await read('compose.yaml'))
  assert.equal(compose.services['proxy-port-manager'].image, `proxy-port-manager:${version}`)
  const chinese = await read('CHANGELOG.md'), english = await read('CHANGELOG_EN.md')
  assert.ok(extractChangelogSection(english, version))
  const versions = text => [...text.matchAll(/^## \[(\d[^\]]*)\] - (\d{4}-\d{2}-\d{2})$/gm)].map(match => [match[1], match[2]])
  assert.deepEqual(versions(chinese.replaceAll('\r', '')), versions(english.replaceAll('\r', '')))
  for (const file of ['README.md', 'README_EN.md', 'RELEASING.md', 'RELEASING_EN.md']) {
    assert.ok((await read(file)).includes(version), `${file} missing current version`)
  }
})

test('双语自动化指南列出的接口与实际 API 合同一致', async () => {
  const expected = API_OPERATIONS.map(operation => `${operation.method.toUpperCase()} /api/v1${operation.path.replace(/:([a-z]+)/g, '{$1}')}`).sort()
  for (const file of ['AUTOMATION.md', 'AUTOMATION_EN.md']) {
    const listed = [...(await read(file)).matchAll(/^(GET|POST|PUT|PATCH|DELETE)\s+(\/api\/v1\S+)\s*$/gm)].map(match => `${match[1]} ${match[2]}`).sort()
    assert.deepEqual(listed, expected, file)
  }
})

test('双语新手入口说明包含相同启动文件、安全提示和阅读入口', async () => {
  for (const file of ['开始使用.txt', 'START_HERE.txt']) {
    const content = await read(file)
    for (const required of ['启动管理器.cmd', '打开管理页面.cmd', '停止管理器.cmd', '1.2.0', 'Source code', '4173', 'data', 'config.env']) {
      assert.ok(content.includes(required), `${file} missing ${required}`)
    }
    for (const index of ['README.md', 'README_EN.md']) assert.ok(links(await read(index)).includes(file))
  }
})

test('Windows 高级命令使用内部入口，文档没有遗留根目录调用', async () => {
  await read('bin/ppm.cmd')
  for (const file of [...DOCUMENTATION_PAIRS.flat(), '开始使用.txt', 'START_HERE.txt']) {
    assert.ok(!(await read(file)).includes('.\\ppm.cmd'), `${file} still uses the old Windows entry point`)
  }
  for (const file of ['PORTABLE_ZH.md', 'PORTABLE.md', 'AUTOMATION.md', 'AUTOMATION_EN.md']) {
    assert.ok((await read(file)).includes('.\\bin\\ppm.cmd'), `${file} missing internal CLI path`)
  }
})

test('便携文档复制保留全部双语指南、许可证与图片，不包含运行数据', async t => {
  const destination = await mkdtemp(path.join(os.tmpdir(), 'ppm-docs-test-'))
  t.after(() => rm(destination, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  await copyDocumentation(root, destination)
  for (const file of DOCUMENTATION_FILES) {
    assert.deepEqual(await readFile(path.join(destination, file)), await readFile(path.join(root, file)), file)
  }
  const copied = (await readdir(destination, { recursive: true })).map(file => file.replaceAll('\\', '/')).sort()
  const directories = [...new Set(DOCUMENTATION_FILES.map(file => path.posix.dirname(file)).filter(dir => dir !== '.'))]
  assert.deepEqual(copied, [...DOCUMENTATION_FILES, ...directories].sort())
  const builder = await read('scripts/build-portable.mjs')
  assert.match(builder, /await copyDocumentation\(projectRoot, stage\)/)
})
