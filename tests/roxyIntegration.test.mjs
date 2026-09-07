import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { RoxyClient } from '../server/browser/roxyClient.mjs'
import { RoxyIntegrationStore } from '../server/browser/roxyStore.mjs'
import { RoxyIntegrationService } from '../server/browser/roxyService.mjs'

function response(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

test('Roxy client discovers team/project and window IDs without exposing unrelated response fields', async () => {
  const calls = []
  const client = new RoxyClient({ token: 'roxy-secret', fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options })
    if (String(url).includes('/browser/workspace')) return response({ code: 0, data: { rows: [{ id: 'team-1', workspaceName: '主团队', project_details: [{ projectId: 'project-1', projectName: '项目一', internal: 'hidden' }] }] }, accountSecret: 'hidden' })
    if (String(url).includes('/browser/list_v3')) return response({ code: 0, data: { total: 1, rows: [{ dirId: 'window-1', windowName: '窗口一', windowSortNum: 8, windowRemark: '常用', projectId: 'project-1', cookie: 'hidden' }] } })
    throw new Error(`unexpected ${url}`)
  } })
  assert.deepEqual(await client.listWorkspaces(), [{ workspaceId: 'team-1', workspaceName: '主团队', projectId: 'project-1', projectName: '项目一' }])
  assert.deepEqual(await client.listWindows({ workspaceId: 'team-1', projectId: 'project-1' }), [{ dirId: 'window-1', windowName: '窗口一', windowSortNum: 8, windowRemark: '常用', projectId: 'project-1', coreType: '', os: '' }])
  assert.equal(calls[0].options.headers.token, 'roxy-secret')
  assert.match(calls[1].url, /projectIds=project-1/)
})

test('Roxy configuration encrypts the API key and enforces one browser window per port', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ppm-roxy-store-')), filename = path.join(directory, 'browser.sqlite')
  const store = new RoxyIntegrationStore({ filename, masterKey: 'test-browser-master-key-123456' })
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }) })
  store.saveConfig({ apiPort: 50000, apiKey: 'plain-roxy-api-secret' })
  assert.equal(store.config().hasApiKey, true)
  assert.equal(store.config().apiKey, undefined)
  assert.equal(store.config({ secrets: true }).apiKey, 'plain-roxy-api-secret')
  store.saveBinding(17900, { workspaceId: 'team', dirId: 'window', windowName: '窗口', syncProxy: true })
  assert.throws(() => store.saveBinding(17901, { workspaceId: 'team', dirId: 'window', windowName: '窗口' }), { code: 'ROXY_WINDOW_ALREADY_BOUND' })
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  assert.equal((await readFile(filename)).includes(Buffer.from('plain-roxy-api-secret')), false)
})

test('Roxy launch pins the session before opening and ends it after the selected window closes', async t => {
  const store = new RoxyIntegrationStore({ masterKey: 'test-browser-master-key-123456' })
  t.after(() => store.close())
  store.saveConfig({ apiPort: 50000, apiKey: 'roxy-secret' })
  let running = false, current = null, ended = 0
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname
    calls.push(pathname)
    if (pathname === '/browser/list_v3') return response({ code: 0, data: { total: 1, rows: [{ dirId: 'window-1', windowName: '窗口一', windowSortNum: 1 }] } })
    if (pathname === '/browser/connection_info') return response({ code: 0, data: running ? [{ dirId: 'window-1' }] : [] })
    if (pathname === '/browser/mdf') {
      const body = JSON.parse(options.body); assert.equal(body.proxyInfo.host, '127.0.0.1'); assert.equal(body.proxyInfo.port, '17900')
      return response({ code: 0, data: {} })
    }
    if (pathname === '/browser/open') { assert.ok(current, 'proxy session must start before Roxy opens'); running = true; return response({ code: 0, data: { dirId: 'window-1' } }) }
    throw new Error(`unexpected ${url}`)
  }
  const service = new RoxyIntegrationService({
    store, fetchImpl, monitorIntervalMs: 5,
    loadCatalog: async () => ({ listeners: [{ port: 17900, protocol: 'Mixed', strategy: 'session-round-robin', enabled: true }] }),
    proxySessionStore: { current: () => current?.session || null, openSessions: () => [] },
    getSession: async () => current || { port: 17900, state: 'idle', session: null },
    startSession: async (_port, input) => (current = { port: 17900, state: 'active', session: { sessionId: 'session-1', profileId: input.profileId, nodeName: '节点 A' } }),
    endSession: async () => { ended++; current = null; return { port: 17900, state: 'ended', session: null } },
  })
  t.after(() => service.stop())
  await service.saveBinding(17900, { workspaceId: 'team-1', projectId: '', dirId: 'window-1', windowName: '窗口一', syncProxy: true })
  const started = await service.start(17900)
  assert.equal(started.state, 'active')
  assert.deepEqual(calls.slice(-3), ['/browser/connection_info', '/browser/mdf', '/browser/open'])
  running = false
  const deadline = Date.now() + 500
  while (!ended && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(ended, 1)
})
