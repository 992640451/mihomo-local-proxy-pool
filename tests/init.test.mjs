import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { generateConfiguration, initializeEnvironment, resetPassword } from '../scripts/init.mjs'

test('generates a native-mode environment without storing the plaintext password', () => {
  const generated = generateConfiguration({
    username: 'maintainer', password: 'a-strong-test-password', controllerSecret: 'a'.repeat(64), salt: 'b'.repeat(32),
  })
  assert.match(generated.content, /^SUBSCRIPTION_MODE=native$/m)
  assert.match(generated.content, /^AUTH_USERNAME=maintainer$/m)
  assert.match(generated.content, /^MIHOMO_CONTROLLER_SECRET=a{64}$/m)
  assert.doesNotMatch(generated.content, /a-strong-test-password/)
  assert.match(generated.content, /^AUTH_PASSWORD_SCRYPT=[a-f0-9]{128}$/m)
})

test('refuses to overwrite an environment unless force is explicit', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ppm-init-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = await initializeEnvironment({ root, username: 'admin', password: 'first-test-password' })
  assert.equal((await readFile(first.envPath, 'utf8')).includes('first-test-password'), false)
  await assert.rejects(() => initializeEnvironment({ root }), /已存在/)
  await initializeEnvironment({ root, force: true, username: 'admin2', password: 'second-test-password' })
  assert.match(await readFile(first.envPath, 'utf8'), /^AUTH_USERNAME=admin2$/m)
})

test('resets only login credentials while preserving the subscription encryption key', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ppm-reset-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const initialized = await initializeEnvironment({ root, username: 'admin', password: 'first-test-password' })
  const before = await readFile(initialized.envPath, 'utf8')
  const secret = before.match(/^MIHOMO_CONTROLLER_SECRET=(.*)$/m)[1]
  await resetPassword({ root, password: 'replacement-password' })
  const after = await readFile(initialized.envPath, 'utf8')
  assert.match(after, /^AUTH_USERNAME=admin$/m)
  assert.match(after, new RegExp(`^MIHOMO_CONTROLLER_SECRET=${secret}$`, 'm'))
  assert.match(after, /^AUTH_SESSION_VERSION=2$/m)
  assert.doesNotMatch(after, /replacement-password/)
  assert.notEqual(before.match(/^AUTH_PASSWORD_SCRYPT=(.*)$/m)[1], after.match(/^AUTH_PASSWORD_SCRYPT=(.*)$/m)[1])
})
