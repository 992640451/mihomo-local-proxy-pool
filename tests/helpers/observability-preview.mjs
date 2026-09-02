// Isolated, synthetic UI fixture. Never reads .env or touches deployed data.
import http from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { scryptSync } from 'node:crypto'
import { SubscriptionStore } from '../../server/subscriptions/store.mjs'
import { SubscriptionService } from '../../server/subscriptions/service.mjs'
import { ObservationStore } from '../../server/observability/store.mjs'

const directory = await mkdtemp(path.join(os.tmpdir(), 'ppm-observation-preview-'))
const subscriptions = new SubscriptionStore({ filename: path.join(directory, 'subscriptions.sqlite'), masterKey: 'synthetic-preview-master-key' })
const service = new SubscriptionService({ store: subscriptions })
await service.create({ name: '演示订阅 A', content: 'proxies:\n  - { name: 日本 · 示例节点 A, type: http, server: example.invalid, port: 8080 }\n  - { name: 美国 · 示例节点 B, type: http, server: example.invalid, port: 8081 }' })
await service.create({ name: '演示订阅 B', content: 'proxies:\n  - { name: 香港 · 示例节点 C, type: http, server: example.invalid, port: 8082 }' })
const definitions = subscriptions.definitions()
subscriptions.close()
const proxy = http.createServer((_req, res) => {
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ ip: '192.0.2.8', country_code: 'JP', success: true }))
})
proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening')
const port = proxy.address().port
const ports = { [port]: { port, nodeIds: definitions.slice(0, 2).map(node => node.id), strategy: 'fallback', protocol: 'HTTP', enabled: true } }
await writeFile(path.join(directory, 'state.json'), JSON.stringify({ version: 2, ports }))
const states = Object.fromEntries(definitions.map((node, index) => [`ppm-node-${node.id}`, { alive: index !== 1, history: index === 2 ? [] : [{ time: new Date().toISOString(), delay: index ? 0 : 42 }] }]))
const controller = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json')
  if (req.url.startsWith('/configs')) return res.end('{}')
  if (req.url === '/version') return res.end(JSON.stringify({ version: 'synthetic', meta: true }))
  if (req.url === '/proxies') return res.end(JSON.stringify({ proxies: { ...states, [`PPM-${port}`]: { now: `ppm-node-${definitions[0].id}` } } }))
  if (req.url.includes('/delay?')) {
    const name = decodeURIComponent(req.url.split('/')[2])
    states[name] = { alive: true, history: [{ time: new Date().toISOString(), delay: 38 }] }
    return setTimeout(() => res.end(JSON.stringify({ delay: 38 })), 150)
  }
  res.statusCode = 404; res.end('{}')
})
controller.listen(0, '127.0.0.1'); await once(controller, 'listening')
const history = new ObservationStore({ filename: path.join(directory, 'observability.sqlite') })
for (let hour = 23; hour >= 0; hour--) {
  history.record({ kind: 'port', targetId: String(port), checkedAt: Date.now() - hour * 3600000, attempts: 2, successes: hour % 5 === 0 ? 1 : 2, latencyMs: 45 + hour, source: 'manual',
    uniqueExitCount: 1, distribution: [{ ip: '192.0.2.8', country: '日本', count: hour % 5 === 0 ? 1 : 2 }], configuration: { protocol: 'HTTP', strategy: 'fallback', nodeIds: definitions.slice(0, 2).map(node => node.id) } })
}
history.close()
const child = spawn(process.execPath, ['server/index.mjs'], { stdio: ['ignore', 'inherit', 'inherit'], env: {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|comspec|pathext|temp|tmp|home|userprofile|localappdata|lang)$/i.test(key))),
  APP_HOST: '127.0.0.1', PORT: process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : '43021',
  AUTH_USERNAME: process.argv.includes('--auth') ? 'preview-admin' : '',
  AUTH_PASSWORD_SALT: process.argv.includes('--auth') ? 'synthetic-salt' : '',
  AUTH_PASSWORD_SCRYPT: process.argv.includes('--auth') ? scryptSync('synthetic-preview-password', 'synthetic-salt', 64).toString('hex') : '',
  AUTH_SESSION_DB: path.join(directory, 'sessions.sqlite'), SUBSCRIPTION_MODE: 'native', SUBSCRIPTION_DB: path.join(directory, 'subscriptions.sqlite'),
  SUBSCRIPTION_MASTER_KEY: 'synthetic-preview-master-key', AUDIT_DB: path.join(directory, 'audit.sqlite'), OBSERVABILITY_DB: path.join(directory, 'observability.sqlite'),
  EMBEDDED_CORE_ENABLED: 'true', EMBEDDED_CORE_STATE_PATH: path.join(directory, 'state.json'), EMBEDDED_CORE_CONFIG_PATH: path.join(directory, 'config.yaml'),
  EMBEDDED_CORE_CONTROLLER_URL: `http://127.0.0.1:${controller.address().port}`, EMBEDDED_CORE_SECRET: '', EMBEDDED_CORE_PORT_RANGES: '',
  PROBE_HOST: '127.0.0.1', EGRESS_LOOKUP_URL: 'http://egress.invalid/',
} })
let closing = false
async function close() {
  if (closing) return
  closing = true
  if (child.exitCode === null) { child.kill(); await once(child, 'exit') }
  for (const server of [proxy, controller]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  if (process.connected) process.disconnect()
}
process.once('SIGINT', close); process.once('SIGTERM', close)
process.on('message', message => { if (message === 'shutdown') close() })
child.once('exit', close)
