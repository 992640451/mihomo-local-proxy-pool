import express from 'express'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { defaultConfigDir, loadSubscriptionCatalog } from './subscriptionCatalog.mjs'
import { applyMihomoPort, deleteMihomoPort } from './mihomoConfig.mjs'
import { probeProxyEgress } from './egressProbe.mjs'
import { createCredentialVersion, SessionStore } from './sessionStore.mjs'
import { applyEmbeddedPort, deleteEmbeddedPort, embeddedCoreStatus, embeddedListeners, ensureEmbeddedCore, isEmbeddedCoreEnabled } from './embeddedCore.mjs'

const app = express()
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const startedAt = Date.now()
const probeHost = process.env.PROBE_HOST || '127.0.0.1'
const authUser = process.env.AUTH_USERNAME || ''
const authSalt = process.env.AUTH_PASSWORD_SALT || ''
const authHash = process.env.AUTH_PASSWORD_SCRYPT || ''
const authConfigured = Boolean(authUser && authSalt && authHash)
const sessionIdleMs = Math.max(60, Number(process.env.AUTH_SESSION_IDLE_SECONDS || 7200)) * 1000
const sessionAbsoluteMs = Math.max(300, Number(process.env.AUTH_SESSION_MAX_SECONDS || 28800)) * 1000
const rememberedSessionIdleMs = Math.max(sessionIdleMs, Math.max(60, Number(process.env.AUTH_REMEMBER_IDLE_SECONDS || 2592000)) * 1000)
const rememberedSessionAbsoluteMs = Math.max(sessionAbsoluteMs, Math.max(300, Number(process.env.AUTH_REMEMBER_MAX_SECONDS || 2592000)) * 1000)
const sessionTouchMs = Math.max(1, Number(process.env.AUTH_SESSION_TOUCH_SECONDS || 300)) * 1000
const sessionCookieName = 'ppm_session'
const attempts = new Map()
const embeddedCore = isEmbeddedCoreEnabled()
const sessionStore = new SessionStore({
  filename: process.env.AUTH_SESSION_DB || ':memory:',
  idleMs: sessionIdleMs,
  absoluteMs: sessionAbsoluteMs,
  touchIntervalMs: sessionTouchMs,
  credentialVersion: createCredentialVersion(authUser, authHash, process.env.AUTH_SESSION_VERSION || '1'),
})

app.use(express.json({ limit: '8kb' }))

app.get('/healthz', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({
    status: 'ok',
    uptimeSeconds: Math.floor(process.uptime()),
  })
})

async function loadLiveCatalog() {
  const source = defaultConfigDir(), catalog = await loadSubscriptionCatalog(source)
  if (embeddedCore) catalog.listeners = await embeddedListeners(source)
  return catalog
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const separator = part.indexOf('=')
    if (separator < 0) return [part, '']
    try { return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))] }
    catch { return [part.slice(0, separator), ''] }
  }))
}

function cookieHeader(req, value, maxAgeSeconds) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase()
  const secure = process.env.AUTH_COOKIE_SECURE === 'true' || req.secure || forwardedProto === 'https'
  return [`${sessionCookieName}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', Number.isFinite(maxAgeSeconds) ? `Max-Age=${maxAgeSeconds}` : '', secure ? 'Secure' : ''].filter(Boolean).join('; ')
}

function findSession(req, touch = false) {
  const id = parseCookies(req)[sessionCookieName]
  const session = sessionStore.find(id, { touch })
  if (!id || !session) return null
  return { id, session }
}

function pruneSessions() {
  sessionStore.prune()
}

function requireAuth(req, res, next) {
  if (!authConfigured) return next()
  if (!findSession(req, true)) return res.status(401).set('Cache-Control', 'no-store').set('Set-Cookie', cookieHeader(req, '', 0)).json({ error: 'AUTH_REQUIRED' })
  next()
}

app.post('/api/auth/login', (req, res) => {
  if (!authConfigured) return res.status(503).json({ error: 'AUTH_NOT_CONFIGURED' })
  const key = req.ip, now = Date.now(), record = attempts.get(key) || { count: 0, since: now }
  if (now - record.since > 15 * 60 * 1000) { record.count = 0; record.since = now }
  if (record.count >= 8) return res.status(429).set('Retry-After', '900').json({ error: 'TOO_MANY_ATTEMPTS' })
  const username = String(req.body?.username || ''), password = String(req.body?.password || ''), remember = req.body?.remember === true
  const candidate = scryptSync(password, authSalt, 64), expected = Buffer.from(authHash, 'hex')
  const valid = username === authUser && candidate.length === expected.length && timingSafeEqual(candidate, expected)
  if (!valid) { record.count += 1; attempts.set(key, record); return res.status(401).json({ error: 'INVALID_CREDENTIALS', remaining: Math.max(0, 8 - record.count) }) }
  attempts.delete(key)
  pruneSessions()
  const id = randomBytes(32).toString('base64url')
  const idleMs = remember ? rememberedSessionIdleMs : sessionIdleMs
  const absoluteMs = remember ? rememberedSessionAbsoluteMs : sessionAbsoluteMs
  sessionStore.create(id, username, now, { idleMs, absoluteMs })
  res.set('Cache-Control', 'no-store').set('Set-Cookie', cookieHeader(req, id, remember ? Math.floor(absoluteMs / 1000) : undefined)).json({ authenticated: true, remembered: remember, expiresIn: Math.floor(Math.min(idleMs, absoluteMs) / 1000) })
})

app.get('/api/auth/session', (req, res) => {
  if (!authConfigured) return res.json({ authenticated: true, expiresIn: null })
  const found = findSession(req, true)
  if (!found) return res.status(401).set('Cache-Control', 'no-store').set('Set-Cookie', cookieHeader(req, '', 0)).json({ authenticated: false })
  const remaining = Math.max(0, Math.min(found.session.idleTimeoutMs, found.session.absoluteExpiresAt - Date.now()))
  res.set('Cache-Control', 'no-store').json({ authenticated: true, remembered: found.session.idleTimeoutMs > sessionIdleMs, expiresIn: Math.floor(remaining / 1000) })
})

app.post('/api/auth/logout', (req, res) => {
  const id = parseCookies(req)[sessionCookieName]
  sessionStore.delete(id)
  res.status(204).set('Cache-Control', 'no-store').set('Set-Cookie', cookieHeader(req, '', 0)).end()
})

app.use('/api', requireAuth)
app.get('/api/subscriptions/catalog', async (_req, res) => {
  try { res.set('Cache-Control', 'no-store').json(await loadLiveCatalog()) }
  catch (error) { res.status(500).json({ error: '订阅配置读取失败', detail: error.message }) }
})
app.get('/api/runtime', async (_req, res) => {
  try {
    const catalog = await loadLiveCatalog(), core = embeddedCore ? await embeddedCoreStatus() : { enabled: false }
    res.set('Cache-Control', 'no-store').json({ startedAt, processUptimeSeconds: Math.floor(process.uptime()), systemUptimeSeconds: Math.floor(os.uptime()), totalNodes: catalog.nodes.length, providerCount: catalog.providers.length, countryCount: catalog.countries.length, hostname: os.hostname(), platform: `${os.platform()} ${os.release()}`, core })
  } catch (error) { res.status(500).json({ error: '运行状态读取失败', detail: error.message }) }
})
app.put('/api/ports/:port', async (req, res) => {
  try {
    const applyPort = embeddedCore ? applyEmbeddedPort : applyMihomoPort
    const result = await applyPort({
      source: defaultConfigDir(),
      port: req.params.port,
      nodeId: String(req.body?.nodeId || ''),
      protocol: String(req.body?.protocol || 'Mixed'),
      enabled: req.body?.enabled !== false,
    })
    res.set('Cache-Control', 'no-store').json(result)
  } catch (error) {
    res.status(400).json({ error: '端口配置应用失败', detail: error.message })
  }
})
app.delete('/api/ports/:port', async (req, res) => {
  try {
    const deletePort = embeddedCore ? deleteEmbeddedPort : deleteMihomoPort
    const result = await deletePort({ source: defaultConfigDir(), port: req.params.port })
    res.set('Cache-Control', 'no-store').json(result)
  } catch (error) {
    res.status(400).json({ error: '端口配置删除失败', detail: error.message })
  }
})
app.get('/api/ports/:port/test', async (req, res) => {
  const port = Number(req.params.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ error: '端口无效' })
  let listener = null
  try {
    const catalog = await loadLiveCatalog()
    listener = (catalog.listeners || []).find(item => Number(item.port) === port) || null
  } catch {}
  const started = Date.now(), socket = net.createConnection({ host: probeHost, port })
  let finished = false
  const done = open => { if (finished) return; finished = true; socket.destroy(); res.json({ host: probeHost, port, open, latencyMs: Date.now() - started, proxy: listener?.routeName || null, listenerName: listener?.listenerName || null }) }
  socket.setTimeout(1500)
  socket.once('connect', () => done(true))
  socket.once('timeout', () => done(false))
  socket.once('error', () => done(false))
})
app.get('/api/ports/:port/egress', async (req, res) => {
  const port = Number(req.params.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ error: '端口无效' })
  try {
    const catalog = await loadLiveCatalog()
    const listener = (catalog.listeners || []).find(item => Number(item.port) === port)
    if (!listener?.isGlobal) return res.status(400).json({ error: '仅全局动态路由支持出口国家检测' })
    res.set('Cache-Control', 'no-store').json({ port, ...(await probeProxyEgress({ host: probeHost, port })) })
  } catch (error) {
    res.status(502).json({ error: '出口国家检测失败', detail: error.message })
  }
})
app.use(express.static(path.join(root, 'dist')))
app.use((_req, res) => res.sendFile(path.join(root, 'dist', 'index.html')))
const port = Number(process.env.PORT || 4180)
const appHost = process.env.APP_HOST || '127.0.0.1'
if (embeddedCore) await ensureEmbeddedCore(defaultConfigDir())
const server = app.listen(port, appHost, () => console.log(`subscription API listening at http://${appHost}:${port}`))

function shutdown() {
  server.close(() => {
    sessionStore.close()
    process.exit(0)
  })
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
