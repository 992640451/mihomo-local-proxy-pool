import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { automationBaseUrl, runAutomation } from '../scripts/automation-cli.mjs'

const env = { PPM_API_TOKEN: `ppm_${'a'.repeat(43)}`, PPM_BACKUP_PASSWORD: 'test-backup-password' }
async function temporary(t) { const directory = await mkdtemp(path.join(os.tmpdir(), 'ppm-cli-test-')); t.after(() => rm(directory, { recursive: true, force: true })); return directory }
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })

test('automation CLI validates destination transport and rejects ambiguous or secret argv options', async () => {
  for (const url of ['http://remote.example', 'ftp://localhost', 'https://user:secret@example.com', 'https://example.com?token=secret', 'https://example.com#secret']) assert.throws(() => automationBaseUrl(url))
  assert.equal(automationBaseUrl('https://example.com/ppm/'), 'https://example.com/ppm')
  assert.equal(automationBaseUrl('http://[::1]:4173'), 'http://[::1]:4173')
  for (const [command, args] of [['restore', ['file.json', '--apply']], ['restore', ['file.json', '--apply', '--dry-run', '--plan', 'plan.json']], ['doctor', ['--all']], ['subscriptions', ['refresh', 'id', '--all']], ['ports', ['list', '--token=never-log-this-secret']]]) {
    await assert.rejects(() => runAutomation(command, args, { env }), error => !error.message.includes('never-log-this-secret'))
  }
})

test('CLI read commands and partial refresh failures produce JSON and meaningful exit codes', async () => {
  const calls = [], output = []
  const options = { env, stdout: text => output.push(JSON.parse(text)), fetchImpl: async (url, init) => {
    calls.push({ url, init })
    if (url.endsWith('/diagnostics')) return json({ status: 'error', checks: [] })
    if (url.endsWith('/ports')) return json({ ports: [] })
    return json({ results: [{ id: 'one', ok: false }] })
  } }
  assert.equal(await runAutomation('doctor', [], options), 2)
  assert.equal(await runAutomation('ports', ['list'], options), 0)
  assert.equal(await runAutomation('subscriptions', ['refresh', '--all'], options), 2)
  assert.equal(calls[2].init.method, 'POST')
  assert.equal(calls[2].init.redirect, 'error')
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${env.PPM_API_TOKEN}`)
  assert.equal(JSON.stringify(output).includes(env.PPM_API_TOKEN), false)
})

test('backup and restore are encrypted-file workflows, default dry-run and never overwrite files', async t => {
  const directory = await temporary(t), filename = path.join(directory, 'backup.json'), planFile = path.join(directory, 'plan.json')
  const calls = [], output = []
  const options = { env, stdout: text => output.push(JSON.parse(text)), fetchImpl: async (url, init) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null })
    if (url.endsWith('/export')) return json({ format: 'ppm-recovery', cipher: { data: 'encrypted' }, summary: { ports: 1 } })
    if (url.endsWith('/plan')) return json({ canApply: true, planToken: 'signed-plan', changes: { ports: { added: ['17900'] } } })
    return json({ ports: 1 })
  } }
  assert.equal(await runAutomation('backup', [filename], options), 0)
  const before = await readFile(filename, 'utf8')
  assert.equal(before.includes(env.PPM_BACKUP_PASSWORD), false)
  await assert.rejects(() => runAutomation('backup', [filename], options), { code: 'EEXIST' })
  assert.equal(await readFile(filename, 'utf8'), before)
  assert.equal(await runAutomation('restore', [filename, '--plan', planFile], options), 0)
  assert.equal(calls.at(-1).url.endsWith('/config/plan'), true)
  assert.equal(calls.some(call => call.url.endsWith('/apply')), false)
  assert.equal(await runAutomation('restore', [filename, '--apply', '--plan', planFile], options), 0)
  assert.equal(calls.at(-1).body.planToken, 'signed-plan')
  assert.equal(calls.at(-1).body.password, env.PPM_BACKUP_PASSWORD)
  await assert.rejects(() => runAutomation('restore', [filename, '--plan', planFile], options), { code: 'EEXIST' })
  assert.equal(JSON.stringify(output).includes(env.PPM_BACKUP_PASSWORD), false)
  await assert.rejects(() => runAutomation('restore', [filename, '--apply', '--plan', planFile, '--url', 'https://other.example'], options), /目标地址/)
})

test('secret files work without exposing credentials; blocked plans exit 2 and cannot be applied', async t => {
  const directory = await temporary(t), tokenFile = path.join(directory, 'api-secret'), passwordFile = path.join(directory, 'password'), filename = path.join(directory, 'backup.json'), planFile = path.join(directory, 'plan.json')
  await writeFile(tokenFile, `${env.PPM_API_TOKEN}\n`); await writeFile(passwordFile, `${env.PPM_BACKUP_PASSWORD}\n`); await writeFile(filename, '{}')
  const options = { env: { PPM_API_TOKEN_FILE: tokenFile, PPM_BACKUP_PASSWORD_FILE: passwordFile }, stdout: () => {}, fetchImpl: async (_url, init) => {
    assert.equal(init.headers.Authorization, `Bearer ${env.PPM_API_TOKEN}`)
    return json({ canApply: false, planToken: null })
  } }
  assert.equal(await runAutomation('restore', [filename, '--plan', planFile], options), 2)
  await assert.rejects(() => runAutomation('restore', [filename, '--apply', '--plan', planFile], options), /不可应用/)
})

test('CLI refuses redirects without forwarding credentials and never retries failed API requests', async t => {
  let requests = 0, targetRequests = 0
  const target = http.createServer((_req, res) => { targetRequests++; res.end('{}') })
  target.listen(0, '127.0.0.1'); await once(target, 'listening')
  const source = http.createServer((_req, res) => { requests++; res.writeHead(302, { Location: `http://127.0.0.1:${target.address().port}` }); res.end() })
  source.listen(0, '127.0.0.1'); await once(source, 'listening')
  t.after(async () => { for (const server of [source, target]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } })
  await assert.rejects(() => runAutomation('ports', ['list', '--url', `http://127.0.0.1:${source.address().port}`], { env }), /重定向/)
  assert.equal(requests, 1); assert.equal(targetRequests, 0)
  let attempts = 0
  await assert.rejects(() => runAutomation('subscriptions', ['refresh', '--all'], { env, fetchImpl: async () => { attempts++; return new Response(JSON.stringify({ error: { code: 'BUSY', message: 'busy', requestId: 'trace-1' } }), { status: 409 }) } }), /trace-1/)
  assert.equal(attempts, 1)
})

test('ppm launcher dispatches automation help without creating a portable runtime', async () => {
  const child = spawn(process.execPath, ['scripts/launcher.mjs', 'restore', '--help'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', chunk => { output += chunk })
  const [code] = await once(child, 'exit')
  assert.equal(code, 0); assert.match(output, /--dry-run/); assert.match(output, /PPM_API_TOKEN_FILE/)
})
