import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildNativeCatalog, defaultConfigDir, loadSubscriptionCatalog } from './subscriptionCatalog.mjs'
import { applyMihomoPort, deleteMihomoPort } from './mihomoConfig.mjs'
import { probeProxyEgress, verifyProxyPool } from './egressProbe.mjs'
import { createCredentialVersion, SessionStore } from './sessionStore.mjs'
import { applyEmbeddedPort, deleteEmbeddedPort, embeddedCoreStatus, embeddedListeners, embeddedPortStatus, ensureEmbeddedCore, isEmbeddedCoreEnabled, syncEmbeddedCore } from './embeddedCore.mjs'
import { SubscriptionStore } from './subscriptions/store.mjs'
import { SubscriptionService } from './subscriptions/service.mjs'
import { requestContext } from './http/requestContext.mjs'
import { apiNotFound, apiUnhandledError } from './http/responses.mjs'
import { registerAuthRoutes } from './routes/auth.mjs'
import { registerPortRoutes } from './routes/ports.mjs'
import { registerSubscriptionRoutes } from './routes/subscriptions.mjs'
import { registerHealthRoute, registerRuntimeRoute } from './routes/system.mjs'

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
const embeddedCore = isEmbeddedCoreEnabled()
const subscriptionMode = String(process.env.SUBSCRIPTION_MODE || 'legacy').toLowerCase()
const sessionStore = new SessionStore({
  filename: process.env.AUTH_SESSION_DB || ':memory:',
  idleMs: sessionIdleMs,
  absoluteMs: sessionAbsoluteMs,
  touchIntervalMs: sessionTouchMs,
  credentialVersion: createCredentialVersion(authUser, authHash, process.env.AUTH_SESSION_VERSION || '1'),
})

let subscriptionStore = null, subscriptionService = null
if (subscriptionMode !== 'legacy') {
  subscriptionStore = new SubscriptionStore({
    filename: process.env.SUBSCRIPTION_DB || '/data/subscriptions.sqlite',
    masterKey: process.env.SUBSCRIPTION_MASTER_KEY || process.env.EMBEDDED_CORE_SECRET || authHash,
  })
  subscriptionService = new SubscriptionService({
    store: subscriptionStore,
    mode: subscriptionMode,
    legacySource: process.env.SUBSCRIPTION_LEGACY_SOURCE || defaultConfigDir(),
    fetchOptions: {
      timeoutMs: Number(process.env.SUBSCRIPTION_FETCH_TIMEOUT_MS || 20000),
      maxBytes: Number(process.env.SUBSCRIPTION_MAX_BYTES || 5 * 1024 * 1024),
      allowPrivateNetworks: process.env.SUBSCRIPTION_ALLOW_PRIVATE_NETWORKS === 'true',
      userAgent: process.env.SUBSCRIPTION_USER_AGENT || 'mihomo/1.19.28',
      dohUrls: String(process.env.SUBSCRIPTION_DOH_URLS || '').split(',').map(value => value.trim()).filter(Boolean),
      dohTimeoutMs: Number(process.env.SUBSCRIPTION_DOH_TIMEOUT_MS || 5000),
    },
  })
  await subscriptionService.initialize()
}

const coreOptions = subscriptionService ? { definitionProvider: () => subscriptionService.getDefinitions({ includeOrphaned: true, includeDisabled: true }) } : {}
if (subscriptionService) subscriptionService.onScheduledRefresh = () => syncCoreAfterSubscriptionChange()

async function loadLiveCatalog() {
  const source = defaultConfigDir()
  const catalog = subscriptionService
    ? buildNativeCatalog(subscriptionService.list(), subscriptionService.getDefinitions())
    : await loadSubscriptionCatalog(source)
  if (embeddedCore) catalog.listeners = await embeddedListeners(source, coreOptions)
  return catalog
}

async function syncCoreAfterSubscriptionChange() {
  if (embeddedCore) await syncEmbeddedCore(defaultConfigDir(), coreOptions)
}

app.disable('x-powered-by')
app.use(requestContext)
app.use(express.json({ limit: '6mb' }))
registerHealthRoute(app)

const { requireAuth } = registerAuthRoutes(app, {
  configured: authConfigured,
  username: authUser,
  passwordSalt: authSalt,
  passwordHash: authHash,
  sessionStore,
  sessionIdleMs,
  sessionAbsoluteMs,
  rememberedSessionIdleMs,
  rememberedSessionAbsoluteMs,
  cookieSecure: process.env.AUTH_COOKIE_SECURE === 'true',
})

app.use('/api', requireAuth)
registerSubscriptionRoutes(app, { subscriptionService, subscriptionMode, loadLiveCatalog, syncCoreAfterSubscriptionChange })
registerRuntimeRoute(app, { startedAt, embeddedCore, embeddedCoreStatus, loadLiveCatalog })
registerPortRoutes(app, {
  probeHost,
  embeddedCore,
  coreOptions,
  defaultConfigDir,
  loadLiveCatalog,
  applyEmbeddedPort,
  applyMihomoPort,
  deleteEmbeddedPort,
  deleteMihomoPort,
  embeddedPortStatus,
  probeProxyEgress,
  verifyProxyPool,
})
app.use('/api', apiNotFound)
app.use(express.static(path.join(root, 'dist')))
app.use((_req, res) => res.sendFile(path.join(root, 'dist', 'index.html')))
app.use(apiUnhandledError)

let server = null
let schedulerStarted = false
let stopping = null

export async function startApplication({
  port = Number(process.env.PORT || 4180),
  host = process.env.APP_HOST || '127.0.0.1',
} = {}) {
  if (server) {
    const address = server.address()
    return { app, server, host, port: typeof address === 'object' && address ? address.port : port }
  }
  if (embeddedCore) await ensureEmbeddedCore(defaultConfigDir(), coreOptions)
  if (subscriptionService && !schedulerStarted) {
    subscriptionService.startScheduler()
    schedulerStarted = true
  }
  server = await new Promise((resolve, reject) => {
    const candidate = app.listen(port, host)
    candidate.once('listening', () => resolve(candidate))
    candidate.once('error', reject)
  })
  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : port
  console.log(`subscription API listening at http://${host}:${actualPort}`)
  return { app, server, host, port: actualPort }
}

export function stopApplication() {
  if (stopping) return stopping
  stopping = new Promise((resolve, reject) => {
    if (schedulerStarted) {
      subscriptionService?.stopScheduler()
      schedulerStarted = false
    }
    const finish = error => {
      if (error) return reject(error)
      subscriptionStore?.close()
      sessionStore.close()
      server = null
      resolve()
    }
    if (!server) return finish()
    server.close(finish)
  })
  return stopping
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  await startApplication()
  const shutdown = async () => {
    try { await stopApplication(); process.exit(0) }
    catch (error) { console.error(error); process.exit(1) }
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
