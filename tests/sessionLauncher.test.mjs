import test from 'node:test'
import assert from 'node:assert/strict'
import { createBrowserAdapter, launchBrowserSession } from '../scripts/session-launcher.mjs'
import { runAutomation } from '../scripts/automation-cli.mjs'

function fixture() {
  const calls = [], active = { state: 'active', session: { sessionId: 'session-one', launchId: '', profileId: 'profile-one', nodeName: 'A' } }
  const request = async (path, body) => {
    calls.push([path, body])
    if (path.endsWith('/session')) return { state: 'idle', session: null }
    if (path.endsWith('/sessions')) { active.session.launchId = body.launchId; return active }
    return { state: 'ended' }
  }
  return { calls, active, request, adapter: { running: async () => false, open: async () => calls.push(['browser-open']), waitForExit: async () => calls.push(['browser-exited']) }, print: () => {} }
}
const config = { port: 17900, profileId: 'profile-one' }

test('launcher binds before browser opens and ends the exact session only after exit', async () => {
  const f = fixture()
  assert.equal(await launchBrowserSession(config, f), 0)
  assert.deepEqual(f.calls.map(call => call[0]), ['/ports/17900/session', '/ports/17900/sessions', 'browser-open', 'browser-exited', '/ports/17900/sessions/session-one/end'])
})

test('launcher never starts a browser after failed binding and never ends an uncertain browser lifecycle', async () => {
  const f = fixture()
  f.request = async (path) => { if (path.endsWith('/sessions')) throw new Error('timeout'); return { state: 'idle', session: null } }
  await assert.rejects(() => launchBrowserSession(config, f), /浏览器未启动/)
  assert.equal(f.calls.length, 0)
  const g = fixture(); g.adapter.waitForExit = async () => { throw new Error('Roxy unreachable') }
  await assert.rejects(() => launchBrowserSession(config, g), /unreachable/)
  assert.equal(g.calls.some(([path]) => path.endsWith('/end')), false)
})

test('launcher reuses confirmed running profile without changing nodes or touching another session', async () => {
  const f = fixture(); f.adapter.running = async () => true
  f.request = async () => f.active
  assert.equal(await launchBrowserSession(config, f), 0)
  assert.equal(f.calls.length, 0)
  f.active.session.profileId = 'another'
  await assert.rejects(() => launchBrowserSession(config, f), /未结束的会话/)
})

test('Roxy adapter follows documented API lifecycle and does not expose its API key', async () => {
  const calls = []; let open = false, polls = 0
  const adapter = await createBrowserAdapter({ type: 'roxy', workspaceId: '1', dirId: 'profile-one' }, {
    env: { ROXY_API_KEY: 'synthetic-secret' }, wait: async () => {}, fetchImpl: async (url, options) => {
      calls.push([url, options]); assert.equal(options.headers.token, 'synthetic-secret')
      if (url.endsWith('/browser/open')) { open = true; return Response.json({ code: 0, data: {} }) }
      return Response.json({ code: 0, data: open && polls++ < 2 ? [{ dirId: 'profile-one', pid: 123 }] : [] })
    },
  })
  assert.equal(await adapter.running(), false)
  await adapter.open(); await adapter.waitForExit()
  assert.deepEqual(JSON.parse(calls.find(([url]) => url.endsWith('/browser/open'))[1].body), { workspaceId: '1', dirId: 'profile-one', forceOpen: false })
  assert.equal(calls.some(([url]) => url.includes('synthetic-secret')), false)
  await assert.rejects(() => createBrowserAdapter({ type: 'roxy', workspaceId: '1', dirId: 'a', apiUrl: 'https://unrelated.example' }), /本机/)
})

test('CLI session commands preserve launch IDs and failed starts do not report success', async () => {
  const calls = [], options = { env: { PPM_API_TOKEN: `ppm_${'a'.repeat(43)}` }, stdout: () => {}, fetchImpl: async (url, input) => {
    calls.push([url, input]); return Response.json({ state: url.endsWith('/sessions') ? 'ended' : 'idle' })
  } }
  assert.equal(await runAutomation('ports', ['start', '17900', 'repeatable-launch', 'profile-one'], options), 2)
  assert.deepEqual(JSON.parse(calls[0][1].body), { launchId: 'repeatable-launch', profileId: 'profile-one' })
  assert.equal(await runAutomation('ports', ['session', '17900'], options), 0)
  assert.equal(calls[1][1].method, 'GET')
  assert.equal(await runAutomation('ports', ['end', '17900', 'specific-session'], options), 0)
  assert.match(calls[2][0], /specific-session\/end$/)
})
