import express from 'express'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AuditStore } from './audit/store.mjs'
import { DiagnosticService } from './diagnostics/service.mjs'
import { buildNativeCatalog, defaultConfigDir, loadSubscriptionCatalog } from './subscriptionCatalog.mjs'
import { applyMihomoPort, deleteMihomoPort } from './mihomoConfig.mjs'
import { probeProxyEgress, verifyProxyPool } from './egressProbe.mjs'
import { createCredentialVersion, SessionStore } from './sessionStore.mjs'
import { applyEmbeddedPort, applyEmbeddedSubscriptionChange, deleteEmbeddedPort, embeddedCoreStatus, embeddedListeners, embeddedPortStatus, ensureEmbeddedCore, exportEmbeddedCoreState, isEmbeddedCoreEnabled, restoreEmbeddedCoreState, syncEmbeddedCore, validateEmbeddedCoreState } from './embeddedCore.mjs'
import { SubscriptionStore } from './subscriptions/store.mjs'
import { SubscriptionService } from './subscriptions/service.mjs'
import { requestContext } from './http/requestContext.mjs'
import { apiNotFound, apiUnhandledError } from './http/responses.mjs'
import { registerAuthRoutes } from './routes/auth.mjs'
import { registerAuditRoutes } from './routes/audit.mjs'
import { registerPortRoutes } from './routes/ports.mjs'
import { registerReliabilityRoutes } from './routes/reliability.mjs'
import { registerSubscriptionRoutes } from './routes/subscriptions.mjs'
import { registerHealthRoute, registerRuntimeRoute } from './routes/system.mjs'
import { RecoveryService } from './recovery/service.mjs'
import { createMutationGate } from './recovery/mutationGate.mjs'
import { RECOVERY_MAX_REQUEST_BYTES } from '../shared/recoveryLimits.js'
import { createOriginGuard, securityHeaders } from './security/http.mjs'
import { readBuildInfo } from './runtime/buildInfo.mjs'
import { ObservationStore } from './observability/store.mjs'
import { ObservationController } from './observability/controller.mjs'
import { ObservationService } from './observability/service.mjs'
import { registerObservationRoutes } from './routes/observability.mjs'
import { ApiTokenStore } from './automation/tokenStore.mjs'
import { versionedRegistrar } from './automation/versioned.mjs'
import { registerTokenRoutes } from './routes/tokens.mjs'
import { registerAutomationRoutes } from './routes/automation.mjs'
import { UpdateService, launchPortableWorker } from './updates/service.mjs'
import { registerUpdateRoutes } from './routes/updates.mjs'
import { isUpdateMaintenance, updateControlAuthorized, checkListeners } from './updates/runtime.mjs'

const app = express()
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version || 'unknown'
const buildInfo = readBuildInfo(root)
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
const subscriptionDbFile = process.env.SUBSCRIPTION_DB || '/data/subscriptions.sqlite'
const sessionDbFile = process.env.AUTH_SESSION_DB || ':memory:'
const persistentRoot = [subscriptionMode !== 'legacy' ? subscriptionDbFile : null, sessionDbFile].find(value => value && value !== ':memory:')
const auditDbFile = process.env.AUDIT_DB || (persistentRoot ? path.join(path.dirname(path.resolve(persistentRoot)), 'audit.sqlite') : ':memory:')
const observationDbFile = process.env.OBSERVABILITY_DB || (persistentRoot ? path.join(path.dirname(path.resolve(persistentRoot)), 'observability.sqlite') : ':memory:')
const tokenDbFile = process.env.API_TOKEN_DB || (persistentRoot ? path.join(path.dirname(path.resolve(persistentRoot)), 'api-tokens.sqlite') : ':memory:')
const updateDirectory = process.env.PPM_UPDATE_DIR || (persistentRoot ? path.join(path.dirname(path.resolve(persistentRoot)), '.updates') : path.join(root, '.local', 'updates'))
const updateKeys = JSON.parse(readFileSync(path.join(root, 'release', 'update-public-keys.json'), 'utf8'))
const updateService = new UpdateService({ directory: updateDirectory, version: appVersion, keys: updateKeys, launch: () => launchPortableWorker(updateDirectory) })
const tokenStore = new ApiTokenStore({ filename: tokenDbFile, credentialVersion: createCredentialVersion(authUser, authHash, process.env.AUTH_SESSION_VERSION || '1') })
const observationStore = new ObservationStore({ filename: observationDbFile })
const mutationGate = createMutationGate()
const auditStore = new AuditStore({
  filename: auditDbFile,
  retentionDays: Number(process.env.AUDIT_RETENTION_DAYS || 30),
  maxEvents: Number(process.env.AUDIT_MAX_EVENTS || 10000),
})
const sessionStore = new SessionStore({
  filename: sessionDbFile,
  idleMs: sessionIdleMs,
  absoluteMs: sessionAbsoluteMs,
  touchIntervalMs: sessionTouchMs,
  credentialVersion: createCredentialVersion(authUser, authHash, process.env.AUTH_SESSION_VERSION || '1'),
})

let subscriptionStore = null, subscriptionService = null
if (subscriptionMode !== 'legacy') {
  subscriptionStore = new SubscriptionStore({
    filename: subscriptionDbFile,
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

if (subscriptionService) {
  if (embeddedCore) subscriptionService.applyChange = change => applyEmbeddedSubscriptionChange(defaultConfigDir(), change, coreOptions)
  subscriptionService.runScheduledRefresh = operation => mutationGate.runMutation(operation)
  subscriptionService.onScheduledRefresh = async event => {
    try {
      if (!event.ok) throw event.error
      auditStore.record({ actor: 'scheduler', action: 'subscription.refresh', targetType: 'subscription', targetId: event.subscription.id, message: `已自动刷新订阅“${event.subscription.name}”`, metadata: { nodeCount: event.subscription.nodeCount } })
    } catch (error) {
      auditStore.record({ actor: 'scheduler', action: 'subscription.refresh', outcome: 'failure', targetType: 'subscription', targetId: event.subscription?.id, message: `自动刷新订阅失败：${error.message}` })
    }
  }
}

const observationService = new ObservationService({
  store: observationStore, controller: new ObservationController(), loadCatalog: loadLiveCatalog,
  verifyPool: verifyProxyPool, probeHost, auditStore, mutationGate, enabled: embeddedCore,
})
const recoveryService = new RecoveryService({
  subscriptionStore,
  appVersion,
  exportPorts: embeddedCore ? () => exportEmbeddedCoreState(coreOptions) : null,
  restorePorts: embeddedCore ? state => restoreEmbeddedCoreState(defaultConfigDir(), state, coreOptions) : null,
  validatePorts: embeddedCore ? (state, subscriptions) => validateEmbeddedCoreState(state, new Set(subscriptions.flatMap(item => item.nodes.map(node => node.id))), coreOptions) : null,
  suspend: subscriptionService ? () => {
    const status = subscriptionService.schedulerStatus()
    if (status.refreshing) throw new Error('订阅正在刷新，请等待刷新完成后重试恢复')
    if (status.running) subscriptionService.stopScheduler({ paused: true })
    return status.running
  } : null,
  resume: subscriptionService ? wasRunning => { if (wasRunning) subscriptionService.startScheduler() } : null,
})
const diagnosticService = new DiagnosticService({
  appVersion,
  startedAt,
  subscriptionStore,
  subscriptionService,
  sessionStore,
  tokenStore,
  auditStore,
  observationStore,
  observationService,
  embeddedCore,
  embeddedCoreStatus,
  loadLiveCatalog,
  dataFiles: [subscriptionMode !== 'legacy' ? subscriptionDbFile : null, sessionDbFile, auditDbFile, observationDbFile, tokenDbFile, process.env.EMBEDDED_CORE_STATE_PATH].filter(value => value && value !== ':memory:'),
  deploymentMode: process.env.PPM_PORTABLE === '1' ? 'portable' : process.env.NODE_ENV === 'production' ? 'container' : 'source',
})

app.disable('x-powered-by')
app.use(requestContext)
app.use(securityHeaders)
app.use('/api', createOriginGuard({ allowedOrigins: process.env.APP_ALLOWED_ORIGINS || '', trustProxy: process.env.APP_TRUST_PROXY === 'true' }))
app.use('/api/recovery', express.json({ limit: RECOVERY_MAX_REQUEST_BYTES }))
app.use(['/api/config', '/api/v1/config'], express.json({ limit: RECOVERY_MAX_REQUEST_BYTES }))
app.use(express.json({ limit: '6mb' }))
registerHealthRoute(app)
app.get('/internal/update-ready', async (req, res) => {
  res.set('Cache-Control', 'no-store')
  if (!updateControlAuthorized(req, updateDirectory)) return res.status(403).json({ error: 'forbidden' })
  try {
    for (const store of [subscriptionStore, sessionStore, tokenStore, auditStore, observationStore]) {
      store?.health()
      if (store?.db && store.db.prepare('PRAGMA quick_check').all().some(row => Object.values(row)[0] !== 'ok')) throw new Error('数据库完整性校验失败')
    }
    subscriptionStore?.exportRecovery()
    const catalog = await loadLiveCatalog()
    if (embeddedCore) {
      const core = await embeddedCoreStatus()
      if (!core.reachable) throw new Error('Mihomo 尚未就绪')
      await checkListeners(catalog.listeners || [], probeHost)
    }
    res.json({ ready: true, version: appVersion, revision: buildInfo.revision })
  } catch { res.status(503).json({ ready: false, version: appVersion, revision: buildInfo.revision }) }
})
app.use('/api', (req, res, next) => {
  if (isUpdateMaintenance(updateDirectory) && !['GET', 'HEAD'].includes(req.method) && !req.path.startsWith('/system/updates')) return res.status(503).json({ error: 'UPDATE_IN_PROGRESS', detail: '版本更新正在进行，请等待服务恢复' })
  next()
})

const { requireAuth } = registerAuthRoutes(app, {
  configured: authConfigured,
  username: authUser,
  passwordSalt: authSalt,
  passwordHash: authHash,
  sessionStore,
  tokenStore,
  sessionIdleMs,
  sessionAbsoluteMs,
  rememberedSessionIdleMs,
  rememberedSessionAbsoluteMs,
  cookieSecure: process.env.AUTH_COOKIE_SECURE === 'true',
  auditStore,
})

app.use('/api', requireAuth)
registerUpdateRoutes(app, { service: updateService, auditStore })
registerTokenRoutes(app, { tokenStore, configured: authConfigured, auditStore })
const api = versionedRegistrar(app, { auditStore })
registerAutomationRoutes(api, { recoveryService, loadLiveCatalog, auditStore, mutationGate })
registerObservationRoutes(api, { service: observationService, store: observationStore, auditStore, mutationGate })
registerSubscriptionRoutes(api, { subscriptionService, subscriptionMode, loadLiveCatalog, auditStore, mutationGate })
registerRuntimeRoute(api, { startedAt, appVersion, buildInfo, embeddedCore, embeddedCoreStatus, loadLiveCatalog })
registerAuditRoutes(api, { auditStore, mutationGate })
registerReliabilityRoutes(api, { recoveryService, diagnosticService, auditStore, mutationGate })
registerPortRoutes(api, {
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
  observationService,
  auditStore,
  mutationGate,
})
app.use('/api', apiNotFound)
app.use(express.static(path.join(root, 'dist'), { setHeaders: (res, file) => { if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-store') } }))
app.use((_req, res) => res.set('Cache-Control', 'no-store').sendFile(path.join(root, 'dist', 'index.html')))
app.use(apiUnhandledError)

let server = null
let schedulerStarted = false
let stopping = null
let maintenanceTimer = null
let backgroundEnabled = false
async function reconcileUpdateMaintenance() {
  const enabled = !isUpdateMaintenance(updateDirectory)
  if (enabled === backgroundEnabled) return
  backgroundEnabled = enabled
  if (enabled) {
    if (subscriptionService && !schedulerStarted) { subscriptionService.startScheduler(); schedulerStarted = true }
    observationService.start()
  } else {
    subscriptionService?.stopScheduler()
    schedulerStarted = false
    await observationService.stop()
  }
}

export async function startApplication({
  port = Number(process.env.PORT || 4180),
  host = process.env.APP_HOST || '127.0.0.1',
} = {}) {
  if (server) {
    const address = server.address()
    return { app, server, host, port: typeof address === 'object' && address ? address.port : port }
  }
  if (embeddedCore) {
    await ensureEmbeddedCore(defaultConfigDir(), coreOptions)
    // Compose may leave Mihomo running during an app-only update.
    const core = await embeddedCoreStatus()
    if (core.reachable) await syncCoreAfterSubscriptionChange()
  }
  server = await new Promise((resolve, reject) => {
    const candidate = app.listen(port, host)
    candidate.once('listening', () => resolve(candidate))
    candidate.once('error', reject)
  })
  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : port
  await reconcileUpdateMaintenance()
  maintenanceTimer = setInterval(() => { reconcileUpdateMaintenance().catch(() => {}) }, 500)
  maintenanceTimer.unref()
  console.log(`subscription API listening at http://${host}:${actualPort}`)
  return { app, server, host, port: actualPort }
}

export function stopApplication() {
  if (stopping) return stopping
  stopping = new Promise((resolve, reject) => {
    clearInterval(maintenanceTimer)
    if (schedulerStarted) {
      subscriptionService?.stopScheduler()
      schedulerStarted = false
    }
    const observationStopped = observationService.stop()
    const finish = async error => {
      if (error) return reject(error)
      try {
        await observationStopped
        await subscriptionService?.changeQueue
        observationStore.close()
        subscriptionStore?.close()
        sessionStore.close()
        tokenStore.close()
        auditStore.close()
        server = null
        resolve()
      } catch (cause) { reject(cause) }
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
