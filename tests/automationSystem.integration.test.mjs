import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runAutomation } from '../scripts/automation-cli.mjs'

test('real application and CLI round-trip a backup through dry-run and guarded core reload', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ppm-automation-system-'))
  const child = spawn(process.execPath, ['tests/helpers/observability-preview.mjs', '--auth', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let output = '', errors = ''
  child.stderr.on('data', chunk => { errors += chunk })
  t.after(async () => {
    if (child.exitCode === null) { child.send('shutdown'); await once(child, 'exit') }
    await rm(directory, { recursive: true, force: true })
  })
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture startup timeout: ${errors}`)), 15000)
    child.stdout.on('data', chunk => {
      output += chunk
      const match = /listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(output)
      if (match) { clearTimeout(timer); resolve(match[1]) }
    })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`fixture exited ${code}: ${errors}`)) })
  })
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'preview-admin', password: 'synthetic-preview-password' }) })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const issued = await fetch(`${base}/api/tokens`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'system-smoke', scopes: ['subscriptions:write', 'ports:write'] }) })
  assert.equal(issued.status, 201)
  const token = await issued.json()
  const env = { PPM_API_URL: base, PPM_API_TOKEN: token.secret, PPM_BACKUP_PASSWORD: 'system-test-backup-password' }
  const values = [], options = { env, stdout: value => values.push(JSON.parse(value)) }
  assert.equal(await runAutomation('doctor', [], options), 0)
  assert.equal(await runAutomation('ports', ['list'], options), 0)
  const original = values.at(-1).ports[0]
  const backup = path.join(directory, 'backup.json'), plan = path.join(directory, 'plan.json')
  assert.equal(await runAutomation('backup', [backup], options), 0)
  const update = await fetch(`${base}/api/v1/ports/${original.port}`, { method: 'PUT', headers: { Authorization: `Bearer ${token.secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...original, enabled: false }) })
  assert.equal(update.status, 200)
  assert.equal(await runAutomation('restore', [backup, '--plan', plan], options), 0)
  assert.deepEqual(values.at(-1).changes.ports.modified, [String(original.port)])
  await runAutomation('ports', ['list'], options)
  assert.equal(values.at(-1).ports[0].enabled, false, 'dry-run must not restore the port')
  assert.equal(await runAutomation('restore', [backup, '--apply', '--plan', plan], options), 0)
  await runAutomation('ports', ['list'], options)
  assert.equal(values.at(-1).ports[0].enabled, true)
  assert.equal(values.at(-1).ports.length, 1)
  assert.equal((await readFile(backup, 'utf8')).includes('example.invalid'), false)
  assert.equal(JSON.stringify(values).includes(token.secret), false)
})
