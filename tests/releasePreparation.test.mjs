import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import test from 'node:test'
import YAML from 'yaml'
import { nextVersion, prepareRelease, validateReleasePlan, promoteChangelog, git, RELEASE_FILES } from '../scripts/prepare-release.mjs'
import { githubApi, checkMergedPr, openReleasePr, tagAndDispatch, validateMergedRelease, validatePendingRelease } from '../scripts/release-github.mjs'

const json = value => JSON.stringify(value, null, 2) + '\n'
const commit = (root, message) => git(root, '-c', 'user.name=发布测试', '-c', 'user.email=release-test@example.invalid', 'commit', '-m', message)
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ppm-prepare-release-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  await mkdir(path.join(root, 'release'))
  const files = {
    'package.json': json({ version: '1.3.0', scripts: { test: 'node --test' } }),
    'package-lock.json': json({ version: '1.3.0', packages: { '': { version: '1.3.0' }, 'node_modules/example': { version: '1.3.0' } } }),
    'compose.yaml': '# keep this comment\nservices:\n  proxy-port-manager:\n    image: proxy-port-manager:1.3.0\n  mihomo-core:\n    image: example/core:1.3.0\n',
    'CHANGELOG.md': '## [未发布]\n\n- 人工中文说明\n\n## [1.3.0] - 2026-09-03\n\n- 历史说明\n',
    'CHANGELOG_EN.md': '## [Unreleased]\n\n- Human English notes\n\n## [1.3.0] - 2026-09-03\n\n- History\n',
    'release/update-policy.json': json({ minVersion: '1.2.0', maxVersion: '1.2.0' }),
  }
  for (const [name, value] of Object.entries(files)) await writeFile(path.join(root, name), value)
  git(root, 'init', '-b', 'main'); git(root, 'add', '--', ...Object.keys(files)); commit(root, '初始版本')
  git(root, 'tag', 'v1.3.0')
  await writeFile(path.join(root, 'feature.txt'), 'feature')
  git(root, 'add', '--', 'feature.txt'); commit(root, '新增: 新功能')
  return root
}

test('release choices calculate stable versions and reject malformed/overflow input', () => {
  for (const [choice, version] of [['patch', '1.3.1'], ['minor', '1.4.0'], ['major', '2.0.0']]) assert.equal(nextVersion('1.3.0', choice), version)
  for (const [version, choice] of [['1.3.0-beta.1', 'minor'], ['01.3.0', 'patch'], ['1.3.0', 'minor; echo unsafe'], ['1.3.0', 'toString'], ['9007199254740991.0.0', 'major']]) assert.throws(() => nextVersion(version, choice))
})

test('preparation synchronizes project versions, preserves dependencies/core/history and validates its plan', async t => {
  const root = await fixture(t)
  const plan = await prepareRelease(root, { bump: 'minor', date: '2026-09-07' })
  assert.equal(plan.version, '1.4.0')
  assert.deepEqual(plan.policy, { minVersion: '1.2.0', maxVersion: '1.2.0' })
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json')))
  assert.equal(lock.packages[''].version, '1.4.0')
  assert.equal(lock.packages['node_modules/example'].version, '1.3.0')
  const compose = await readFile(path.join(root, 'compose.yaml'), 'utf8')
  assert.match(compose, /keep this comment/)
  assert.match(compose, /example\/core:1.3.0/)
  const notes = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8')
  assert.match(notes, /## \[未发布\]\n\n## \[1.4.0\] - 2026-09-07\n\n- 人工中文说明/)
  assert.match(notes, /## \[1.3.0\] - 2026-09-03\n\n- 历史说明/)
  await validateReleasePlan(root, plan)
  await writeFile(path.join(root, 'release/update-policy.json'), json({ minVersion: '1.3.0', maxVersion: '1.3.0' }))
  await assert.rejects(validateReleasePlan(root, plan), /升级范围/)
})

test('preparation requires explicit tested-source choice and refuses dirty trees/existing tags before writes', async t => {
  const root = await fixture(t)
  await writeFile(path.join(root, 'untracked.txt'), 'user changes')
  await assert.rejects(prepareRelease(root, { bump: 'patch' }), /先提交/)
  await rm(path.join(root, 'untracked.txt'))
  git(root, 'tag', 'v1.3.1')
  await assert.rejects(prepareRelease(root, { bump: 'patch' }), /标签已存在/)
  assert.equal(JSON.parse(await readFile(path.join(root, 'package.json'))).version, '1.3.0')
  const plan = await prepareRelease(root, { bump: 'minor', upgrade: 'current-tested' })
  assert.deepEqual(plan.policy, { minVersion: '1.3.0', maxVersion: '1.3.0' })
  await validateReleasePlan(root, plan)
})

test('empty notes become reviewable drafts while missing or duplicate headings stop preparation', () => {
  const draft = promoteChangelog('## [Unreleased]\r\n\r\n## [1.3.0]\r\n- Old\r\n', 'en', '1.4.0', '2026-09-07', [{ sha: 'a'.repeat(40), subject: '新增: 功能' }])
  assert.match(draft, /review and translate/)
  assert.match(draft, /新增: 功能 \(aaaaaaa\)/)
  assert.throws(() => promoteChangelog('no heading', 'zh', '1.4.0', '2026-09-07', []), /缺少/)
  assert.throws(() => promoteChangelog(draft, 'en', '1.4.0', '2026-09-07', []), /已包含/)
})

const repository = 'owner/repo', defaultBranch = 'main'
function mergedPr(revision) {
  return { number: 5, merged: true, merge_commit_sha: revision, user: { login: 'github-actions[bot]' },
    base: { ref: 'main', repo: { full_name: repository } }, head: { ref: 'codex/release-v1.4.0', repo: { full_name: repository } } }
}

test('handoff accepts the reviewed merge but rejects forks, unmerged PRs, mixed files and stale main', async t => {
  const root = await fixture(t)
  const plan = await prepareRelease(root, { bump: 'minor' })
  git(root, 'add', '--', ...RELEASE_FILES); commit(root, '构建: 准备 1.4.0 发布')
  const pr = mergedPr(git(root, 'rev-parse', 'HEAD'))
  let files = RELEASE_FILES.map(filename => ({ filename, status: 'modified' }))
  const api = async endpoint => endpoint.includes('/files?') ? files : pr
  await validateMergedRelease({ root, api, repository, defaultBranch, number: 5 })
  assert.throws(() => checkMergedPr({ ...pr, merged: false }, repository, defaultBranch))
  assert.throws(() => checkMergedPr({ ...pr, head: { ...pr.head, repo: { full_name: 'fork/repo' } } }, repository, defaultBranch))
  files = [...files, { filename: 'server/index.mjs', status: 'modified' }]
  await assert.rejects(validateMergedRelease({ root, api, repository, defaultBranch, number: 5 }), /非发布文件/)
  files = files.slice(0, -1)
  // Simulate a release prepared against an older baseline, with a new default-branch change.
  const oldPlan = { ...plan, baseSha: git(root, 'rev-parse', 'v1.3.0') }
  await writeFile(path.join(root, 'release/plan.json'), json(oldPlan))
  await assert.rejects(validateMergedRelease({ root, api, repository, defaultBranch, number: 5 }), /默认分支发生变化/)
})

test('PR preparation uses exact files and explicit CI dispatch; retries do not overwrite reviewer edits', async t => {
  const root = await fixture(t)
  const plan = await prepareRelease(root, { bump: 'minor' })
  const calls = [], branch = `codex/release-${plan.tag}`
  let ref = null, pr = null
  const api = async (endpoint, options = {}) => {
    calls.push([endpoint, options])
    if (endpoint.startsWith('pulls?')) return pr ? [pr] : []
    if (endpoint === 'git/ref/heads/main') return { object: { sha: plan.baseSha } }
    if (endpoint.startsWith('releases/') || endpoint.startsWith('git/ref/tags/')) return null
    if (endpoint === `git/ref/heads/${branch}`) return ref
    if (endpoint.startsWith('contents/')) return { content: Buffer.from(json(plan)).toString('base64') }
    if (endpoint.startsWith('git/commits/')) return { tree: { sha: 'base-tree' } }
    if (endpoint === 'git/blobs') return { sha: 'blob' }
    if (endpoint === 'git/trees') return { sha: 'tree' }
    if (endpoint === 'git/commits') return { sha: 'prepared-sha' }
    if (endpoint === 'git/refs') return ref = { object: { sha: 'prepared-sha' } }
    if (endpoint === 'pulls') return pr = { number: 1, html_url: 'https://github.com/owner/repo/pull/1', head: { ref: branch, repo: { full_name: repository } } }
    if (endpoint.endsWith('/dispatches')) return null
    throw new Error(endpoint)
  }
  const first = await openReleasePr({ root, api, repository, defaultBranch })
  assert.equal(first.url, pr.html_url)
  assert.deepEqual(calls.find(([e]) => e === 'git/trees')[1].body.tree.map(file => file.path), RELEASE_FILES)
  assert.deepEqual(calls.at(-1)[1].body, { ref: branch })
  calls.length = 0
  await openReleasePr({ root, api, repository, defaultBranch })
  assert.equal(calls.filter(([, options]) => options.method === 'POST').length, 1)
  assert.equal(calls.at(-1)[0], 'actions/workflows/ci.yml/dispatches')
})

test('release PR CI blocks an obsolete baseline before merge', async t => {
  const root = await fixture(t), plan = await prepareRelease(root, { bump: 'minor' })
  const options = { root, defaultBranch, branch: `codex/release-${plan.tag}` }
  await validatePendingRelease({ ...options, api: async () => ({ object: { sha: plan.baseSha } }) })
  await assert.rejects(validatePendingRelease({ ...options, api: async () => ({ object: { sha: 'b'.repeat(40) } }) }), /当前 PR 不应合并/)
})

test('tag handoff resumes dispatch after failure, never moves conflicting tags or republishes public releases', async () => {
  const revision = 'a'.repeat(40), plan = { tag: 'v1.4.0', version: '1.4.0' }, calls = []
  let ref = null, failDispatch = true, published = false
  const api = async (endpoint, options = {}) => {
    calls.push([endpoint, options])
    if (endpoint.startsWith('releases/')) return published ? { draft: false } : null
    if (endpoint.startsWith('git/ref/')) return ref
    if (endpoint === 'git/tags') return { sha: 'tag-object' }
    if (endpoint === 'git/refs') { ref = { object: { type: 'tag', sha: 'tag-object' } }; return ref }
    if (endpoint === 'git/tags/tag-object') return { object: { type: 'commit', sha: revision } }
    if (endpoint.includes('/runs?')) return { workflow_runs: [] }
    if (endpoint.endsWith('/dispatches')) { if (failDispatch) throw new Error('dispatch unavailable'); return null }
    throw new Error(endpoint)
  }
  await assert.rejects(tagAndDispatch({ api, plan, revision }), /unavailable/)
  failDispatch = false; calls.length = 0
  await tagAndDispatch({ api, plan, revision })
  assert.equal(calls.some(([e]) => e === 'git/refs'), false)
  assert.deepEqual(calls.at(-1)[1].body, { ref: plan.tag, inputs: { tag: plan.tag, publish: 'true' } })
  ref = { object: { type: 'commit', sha: 'b'.repeat(40) } }
  await assert.rejects(tagAndDispatch({ api, plan, revision }), /拒绝移动/)
  published = true
  await assert.rejects(tagAndDispatch({ api, plan, revision }), /拒绝移动/)
  ref = { object: { type: 'commit', sha: revision } }
  assert.equal((await tagAndDispatch({ api, plan, revision })).status, 'published')
})

test('handoff does not duplicate a running release or restart a failed image publication', async () => {
  const revision = 'a'.repeat(40), plan = { tag: 'v1.4.0', version: '1.4.0' }
  let status = 'in_progress'
  const api = async (endpoint, options) => {
    assert.equal(options?.method, undefined)
    if (endpoint.startsWith('releases/')) return null
    if (endpoint.startsWith('git/ref/')) return { object: { type: 'commit', sha: revision } }
    if (endpoint.includes('/runs?')) return { workflow_runs: [{ head_sha: revision, status, conclusion: 'failure' }] }
    throw new Error(endpoint)
  }
  assert.equal((await tagAndDispatch({ api, plan, revision })).status, 'running')
  status = 'completed'
  await assert.rejects(tagAndDispatch({ api, plan, revision }), /Re-run failed jobs/)
})

test('GitHub API refuses redirects and reports failures without echoing token or response bodies', async () => {
  const api = githubApi({ repository, token: 'synthetic-sensitive-value', fetchImpl: async (_url, options) => {
    assert.equal(options.redirect, 'error')
    return new Response('synthetic-sensitive-value', { status: 403 })
  } })
  await assert.rejects(api('pulls'), error => /403/.test(error.message) && !error.message.includes('synthetic-sensitive-value'))
})

test('web workflows restrict mutations, explicitly dispatch CI and preserve the existing release gates', async () => {
  const load = async name => YAML.parse(await readFile(`.github/workflows/${name}.yml`, 'utf8'))
  const prepare = await load('prepare-release'), publish = await load('publish-release-pr'), ci = await load('ci'), release = await load('release')
  assert.deepEqual(Object.keys(prepare.on), ['workflow_dispatch'])
  assert.equal(prepare.on.workflow_dispatch.inputs.upgrade.default, 'preserve')
  assert.match(prepare.jobs.prepare.if, /default_branch/)
  assert.equal(prepare.jobs.prepare.permissions['pull-requests'], 'write')
  assert.equal(prepare.jobs.prepare.permissions.actions, 'write')
  assert.ok(Object.hasOwn(ci.on, 'workflow_dispatch'))
  assert.deepEqual(publish.on.pull_request.types, ['closed'])
  assert.match(publish.jobs.publish.if, /merged == true/)
  assert.match(publish.jobs.publish.if, /github-actions\[bot\]/)
  assert.equal(publish.on.workflow_dispatch.inputs.pr_number.required, true)
  assert.match(publish.jobs.publish.if, /github.ref_name == github.event.repository.default_branch/)
  assert.equal(publish.jobs.publish.steps.find(step => step.uses?.startsWith('actions/checkout@')).with.ref, '${{ steps.merged.outputs.revision }}')
  const validation = publish.jobs.publish.steps.find(step => step.name === '验证实际合并后的源码').run
  assert.ok(validation.indexOf('cp .env.example .env') >= 0)
  assert.ok(validation.indexOf('cp .env.example .env') < validation.indexOf('docker compose'))
  assert.deepEqual(release.jobs.release.needs, ['validate', 'build-portable', 'container'])
})
