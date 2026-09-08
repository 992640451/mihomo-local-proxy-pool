import { appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RELEASE_FILES, git, validateReleasePlan } from './prepare-release.mjs'

export function githubApi({ repository, token, fetchImpl = fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !token) throw new Error('缺少 GitHub 仓库或工作流令牌')
  return async (endpoint, { method = 'GET', body, optional = false } = {}) => {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/${endpoint}`, {
      method, redirect: 'error', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000),
    })
    if (optional && response.status === 404) return null
    if (!response.ok) throw new Error(`GitHub ${method} ${endpoint.split('?')[0]} 失败（HTTP ${response.status}）。检查 Actions 权限或重跑失败任务。`)
    return response.status === 204 ? null : response.json()
  }
}

export async function allPages(api, endpoint) {
  const result = []
  for (let page = 1; page <= 100; page++) {
    const rows = await api(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
    result.push(...rows)
    if (rows.length < 100) return result
  }
  throw new Error('GitHub 返回数据过多，请人工核查')
}

export async function validatePendingRelease({ root, api, defaultBranch, branch }) {
  const plan = await validateReleasePlan(root, JSON.parse(await readFile(path.join(root, 'release/plan.json'), 'utf8')))
  if (branch !== `codex/release-${plan.tag}`) throw new Error('发布分支与计划版本不一致')
  const base = await api(`git/ref/heads/${encodeURIComponent(defaultBranch)}`)
  if (base.object.sha !== plan.baseSha) throw new Error('默认分支已变化，请关闭发布 PR、删除发布分支后重新准备；当前 PR 不应合并')
  return plan
}

export async function openReleasePr({ root, api, repository, defaultBranch }) {
  const plan = await validateReleasePlan(root, JSON.parse(await readFile(path.join(root, 'release/plan.json'), 'utf8')))
  const branch = `codex/release-${plan.tag}`
  await validatePendingRelease({ root, api, defaultBranch, branch })
  const existing = await allPages(api, `pulls?state=open&base=${encodeURIComponent(defaultBranch)}`)
  const other = existing.find(pr => pr.head.repo?.full_name === repository && pr.head.ref.startsWith('codex/release-') && pr.head.ref !== branch)
  if (other) throw new Error(`已有待审核发布 PR #${other.number}，请先合并或关闭`)
  const published = await api(`releases/tags/${plan.tag}`, { optional: true })
  if (published || await api(`git/ref/tags/${plan.tag}`, { optional: true })) throw new Error('目标版本或标签已存在，不能再次准备')
  let ref = await api(`git/ref/heads/${branch}`, { optional: true })
  if (ref) {
    const saved = await api(`contents/release/plan.json?ref=${ref.object.sha}`)
    const old = JSON.parse(Buffer.from(saved.content, 'base64').toString('utf8'))
    if (JSON.stringify(old) !== JSON.stringify(plan)) throw new Error('已有发布分支的基线或选项不同。请审核现有 PR，或关闭 PR 并删除该分支后重新准备；不会覆盖已有修改。')
  } else {
    const base = await api(`git/commits/${plan.baseSha}`)
    const tree = []
    for (const file of RELEASE_FILES) {
      const blob = await api('git/blobs', { method: 'POST', body: { content: await readFile(path.join(root, file), 'utf8'), encoding: 'utf-8' } })
      tree.push({ path: file, mode: '100644', type: 'blob', sha: blob.sha })
    }
    const nextTree = await api('git/trees', { method: 'POST', body: { base_tree: base.tree.sha, tree } })
    const commit = await api('git/commits', { method: 'POST', body: { message: `构建: 准备 ${plan.version} 发布`, tree: nextTree.sha, parents: [plan.baseSha] } })
    ref = await api('git/refs', { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: commit.sha } })
  }
  let pr = existing.find(item => item.head.repo?.full_name === repository && item.head.ref === branch)
  if (!pr) {
    pr = await api('pulls', { method: 'POST', body: {
      title: `构建: 准备 ${plan.version} 发布`, head: branch, base: defaultBranch,
      body: `准备将 ${plan.previousVersion} 更新至 **${plan.version}**。合并此 PR 会自动创建 ${plan.tag} 并启动正式发布，全部构建、测试和签名通过后公开制品。\n\n` +
        `升级来源范围：**${plan.policy.minVersion} → ${plan.policy.maxVersion}**（含两端）。${plan.upgrade === 'current-tested' ? '发起者已声明完成当前版本到目标版本的升级测试。' : '保留原有范围；这不代表当前版本一定可以网页直升，请核对目标用户的来源版本。'}\n\n` +
        `请在 Files changed 中审核双语发行说明，尤其是自动生成的提交草稿，并等待 CI 通过后合并。可直接在 GitHub 网页编辑说明；英文草稿若包含中文提交标题，需要人工翻译。\n\n` +
        `自动同步包与锁文件、Compose 应用镜像、双语变更记录和发布计划。API 主版本与 Mihomo 版本独立。\n\n` +
        `如果默认分支又加入了需要一同发布的功能，请先关闭此 PR 并删除发布分支，再从“准备新版本”重新生成。\n\n基线提交：\`${plan.baseSha}\`。`,
    } })
  }
  // Explicit dispatch works for GITHUB_TOKEN, even when ordinary bot PR CI needs approval.
  await api('actions/workflows/ci.yml/dispatches', { method: 'POST', body: { ref: branch } })
  return { url: pr.html_url, tag: plan.tag, branch }
}

export function checkMergedPr(pr, repository, defaultBranch) {
  if (!pr.merged || pr.base.ref !== defaultBranch || pr.base.repo?.full_name !== repository || pr.head.repo?.full_name !== repository ||
      !/^codex\/release-v\d+\.\d+\.\d+$/.test(pr.head.ref) || pr.user?.login !== 'github-actions[bot]') throw new Error('仅接受本仓库发布机器人创建并已合并到默认分支的发布 PR')
  if (!/^[a-f0-9]{40}$/.test(pr.merge_commit_sha || '')) throw new Error('合并提交无效')
}

export async function validateMergedRelease({ root, api, repository, defaultBranch, number }) {
  if (!/^\d+$/.test(String(number))) throw new Error('PR 编号无效')
  const pr = await api(`pulls/${number}`)
  checkMergedPr(pr, repository, defaultBranch)
  if (git(root, 'rev-parse', 'HEAD') !== pr.merge_commit_sha) throw new Error('检出内容不是已合并 PR 的准确提交')
  const plan = await validateReleasePlan(root, JSON.parse(await readFile(path.join(root, 'release/plan.json'), 'utf8')))
  if (pr.head.ref !== `codex/release-${plan.tag}`) throw new Error('发布分支与计划版本不一致')
  const files = await allPages(api, `pulls/${number}/files`)
  if (!files.some(file => file.filename === 'release/plan.json') || files.some(file => !RELEASE_FILES.includes(file.filename) || !['added', 'modified'].includes(file.status))) throw new Error('发布 PR 混入了非发布文件，请通过独立代码 PR 合并后重新准备')
  // Refuse stale release PRs even if branch protection allowed merging them.
  const parentVersion = JSON.parse(git(root, 'show', 'HEAD^:package.json')).version
  if (parentVersion !== plan.previousVersion) throw new Error('默认分支已准备其他版本，本发布 PR 已过期')
  const extra = git(root, 'diff', '--name-only', plan.baseSha, 'HEAD^').split('\n').filter(Boolean)
  if (extra.length) throw new Error('准备期间默认分支发生变化，请重新准备发布，确保发行说明覆盖实际源码')
  return plan
}

export async function tagAndDispatch({ api, plan, revision }) {
  const release = await api(`releases/tags/${plan.tag}`, { optional: true })
  const ref = await api(`git/ref/tags/${plan.tag}`, { optional: true })
  if (ref) {
    let object = ref.object
    for (let depth = 0; object.type === 'tag' && depth < 5; depth++) object = (await api(`git/tags/${object.sha}`)).object
    if (object.type !== 'commit' || object.sha !== revision) throw new Error('已有标签指向其他提交，拒绝移动标签')
  } else {
    if (release) throw new Error('已有 Release 缺少对应标签，请人工核查')
    const tag = await api('git/tags', { method: 'POST', body: { tag: plan.tag, message: `发布 ${plan.version}`, object: revision, type: 'commit' } })
    await api('git/refs', { method: 'POST', body: { ref: `refs/tags/${plan.tag}`, sha: tag.sha } })
  }
  if (release && !release.draft) return { status: 'published', tag: plan.tag }
  const runs = await api(`actions/workflows/release.yml/runs?head_sha=${revision}&per_page=100`)
  if (runs.workflow_runs.some(run => run.head_sha === revision && run.status !== 'completed')) return { status: 'running', tag: plan.tag }
  if (runs.workflow_runs.some(run => run.head_sha === revision && run.status === 'completed' && run.conclusion !== 'success')) {
    throw new Error('已有 Release 运行失败，请在该 Release 运行中选择 Re-run failed jobs，避免重复构建已推送镜像')
  }
  // Pin tooling as well as source to the merged release, never a newer main commit.
  await api('actions/workflows/release.yml/dispatches', { method: 'POST', body: { ref: plan.tag, inputs: { tag: plan.tag, publish: 'true' } } })
  return { status: 'dispatched', tag: plan.tag }
}

async function main() {
  const root = process.cwd(), repository = process.env.GITHUB_REPOSITORY, defaultBranch = process.env.RELEASE_DEFAULT_BRANCH
  if (!defaultBranch) throw new Error('缺少默认分支')
  const api = githubApi({ repository, token: process.env.GH_TOKEN })
  const options = { root, api, repository, defaultBranch, number: process.env.RELEASE_PR_NUMBER }
  let result
  if (process.argv[2] === 'pr') result = await openReleasePr(options)
  else if (process.argv[2] === 'verify-pr') {
    const plan = await validatePendingRelease({ ...options, branch: process.env.RELEASE_PR_BRANCH })
    result = { tag: plan.tag, status: 'verified' }
  }
  else if (['verify-merged', 'publish'].includes(process.argv[2])) {
    const plan = await validateMergedRelease(options)
    result = process.argv[2] === 'publish' ? await tagAndDispatch({ api, plan, revision: git(root, 'rev-parse', 'HEAD') }) : { tag: plan.tag, status: 'verified' }
  } else throw new Error('未知发布操作')
  console.log(JSON.stringify(result))
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, result.url ? `已创建/复用 [${result.tag} 发布 PR](${result.url})。请审核 Files changed 和 CI；合并后开始正式发布。\n` : `${result.tag}：${result.status}。请查看 Release 工作流的最终构建与发布结果。\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1 })
