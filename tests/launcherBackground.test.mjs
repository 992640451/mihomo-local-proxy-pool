import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { generateConfiguration } from '../scripts/init.mjs'
import { smokeEnvironment } from '../scripts/smoke-portable.mjs'

const entry = fileURLToPath(new URL('../scripts/launcher.mjs', import.meta.url))

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ppm-background-test-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  await mkdir(path.join(root, 'data', 'runtime'), { recursive: true })
  const config = generateConfiguration().content
  await writeFile(path.join(root, 'data', 'config.env'), config)
  return { root, config, env: smokeEnvironment(root, 4173, 19090) }
}

function start(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, 'start', '--background', '--no-open'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 25000 })
    let output = ''
    const collect = chunk => { output += chunk }
    child.stdout.setEncoding('utf8').on('data', collect)
    child.stderr.setEncoding('utf8').on('data', collect)
    child.once('error', reject)
    child.once('close', code => resolve({ code, output }))
  })
}

test('background start reuses a healthy authenticated instance without changing configuration', async t => {
  const { root, env, config } = await fixture(t)
  let healthCode = 200, reportedPid = process.pid
  const server = http.createServer((req, res) => {
    if (req.url === '/status') {
      assert.equal(req.headers.authorization, 'Bearer test-control-token')
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ pid: reportedPid }))
    } else res.writeHead(healthCode).end('ok')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}`
  const state = { pid: process.pid, managementUrl: url, controlUrl: url, controlToken: 'test-control-token' }
  const stateFile = path.join(root, 'data', 'runtime', 'service.json')
  await writeFile(stateFile, JSON.stringify(state))
  const healthy = await start(env)
  assert.equal(healthy.code, 0)
  assert.match(healthy.output, /Already running/)
  healthCode = 503
  const unhealthy = await start(env)
  assert.equal(unhealthy.code, 1)
  assert.match(unhealthy.output, /Existing process is unhealthy/)
  healthCode = 200
  reportedPid = process.pid + 1
  assert.equal((await start(env)).code, 1, 'a reused PID must not cause an unrelated healthy page to be opened')
  assert.equal(await readFile(path.join(root, 'data', 'config.env'), 'utf8'), config)
  assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), state)
})

test('failed background child returns early with log paths and preserves existing configuration', async t => {
  const { root, env, config } = await fixture(t)
  // No application is installed in this isolated root, so the child fails before
  // binding a port or launching Mihomo. No user service or configuration is used.
  const began = Date.now()
  const failed = await start(env)
  assert.equal(failed.code, 1)
  assert.match(failed.output, /Check logs:/)
  assert.ok(failed.output.includes(path.join(root, 'data', 'logs', 'application.log')))
  assert.ok(Date.now() - began < 15000, 'do not wait for the full readiness timeout after a child exits')
  assert.equal(await readFile(path.join(root, 'data', 'config.env'), 'utf8'), config)
  await assert.rejects(readFile(path.join(root, 'data', 'runtime', 'service.lock')), { code: 'ENOENT' })
})
