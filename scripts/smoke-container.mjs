import assert from 'node:assert/strict'
import { randomBytes, scryptSync } from 'node:crypto'
import { capture } from './build-metadata.mjs'
import { argument } from './release-utils.mjs'

const image = argument(process.argv, '--image')
if (!image) throw new Error('必须指定 --image')
const expectedVersion = argument(process.argv, '--version')
const expectedRevision = argument(process.argv, '--revision')
const platform = argument(process.argv, '--platform')
const password = randomBytes(24).toString('hex'), salt = randomBytes(16).toString('hex')
const configuration = {
  APP_HOST: '0.0.0.0', PORT: '4180', SUBSCRIPTION_MODE: 'native', SUBSCRIPTION_DB: ':memory:',
  SUBSCRIPTION_MASTER_KEY: randomBytes(32).toString('hex'), AUTH_SESSION_DB: ':memory:', AUDIT_DB: ':memory:',
  AUTH_USERNAME: 'smoke-test', AUTH_PASSWORD_SALT: salt, AUTH_PASSWORD_SCRYPT: scryptSync(password, salt, 64).toString('hex'),
  EMBEDDED_CORE_ENABLED: 'false',
}
let container
try {
  container = capture('docker', ['create', ...(platform ? ['--platform', platform] : []), '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '-p', '127.0.0.1::4180', ...Object.entries(configuration).flatMap(([key, value]) => ['-e', `${key}=${value}`]), image])
  assert.match(container, /^[a-f0-9]{64}$/)
  for (let iteration = 0; iteration < 2; iteration += 1) {
    capture('docker', ['start', container])
    const address = capture('docker', ['port', container, '4180/tcp']).split(/\r?\n/)[0]
    assert.match(address, /^127\.0\.0\.1:\d+$/)
    const base = `http://${address}`
    let healthy = false
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try { healthy = (await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) })).ok } catch {}
      if (healthy) break
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    assert.ok(healthy, '容器必须在 30 秒内就绪')
    assert.match(await (await fetch(base, { signal: AbortSignal.timeout(5000) })).text(), /<div id="root">/)
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'smoke-test', password }), signal: AbortSignal.timeout(5000) })
    assert.equal(login.status, 200)
    const response = await fetch(`${base}/api/runtime`, { headers: { Cookie: login.headers.get('set-cookie').split(';')[0] }, signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 200)
    const runtime = await response.json()
    if (expectedVersion) assert.equal(runtime.buildInfo?.version, expectedVersion)
    if (expectedRevision) assert.equal(runtime.buildInfo?.revision, expectedRevision)
    capture('docker', ['stop', '--time', '15', container])
    assert.equal(capture('docker', ['inspect', '--format', '{{.State.ExitCode}}', container]), '0')
  }
  console.log('容器页面、登录、版本信息、停止和重启测试通过')
} finally {
  if (container && /^[a-f0-9]{64}$/.test(container)) capture('docker', ['rm', '-f', container])
}
