import { constants as fsConstants } from 'node:fs'
import { access, statfs } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { redactSensitive, redactText } from '../security/redaction.mjs'

async function capture(name, operation, { warning = false } = {}) {
  const started = Date.now()
  try {
    const details = await operation()
    return { name, status: warning ? 'warning' : 'ok', durationMs: Date.now() - started, details: redactSensitive(details) }
  } catch (error) {
    return { name, status: 'error', durationMs: Date.now() - started, message: redactText(error.message) }
  }
}

function uniqueDirectories(paths) {
  return [...new Set((paths || []).filter(Boolean).map(value => path.dirname(path.resolve(value))))]
}

export class DiagnosticService {
  constructor({
    appVersion = 'unknown',
    startedAt = Date.now(),
    subscriptionStore,
    subscriptionService,
    sessionStore,
    tokenStore,
    auditStore,
    observationStore,
    observationService,
    embeddedCore = false,
    embeddedCoreStatus,
    loadLiveCatalog,
    dataFiles = [],
    deploymentMode = 'source',
  } = {}) {
    Object.assign(this, { appVersion, startedAt, subscriptionStore, subscriptionService, sessionStore, tokenStore, auditStore, observationStore, observationService, embeddedCore, embeddedCoreStatus, loadLiveCatalog, dataFiles, deploymentMode })
  }

  async run() {
    const checks = []
    checks.push(await capture('subscriptionDatabase', () => {
      if (!this.subscriptionStore) return { enabled: false }
      return { enabled: true, ...this.subscriptionStore.health() }
    }))
    checks.push(await capture('sessionDatabase', () => this.sessionStore.health()))
    if (this.tokenStore) checks.push(await capture('apiTokenDatabase', () => this.tokenStore.health()))
    checks.push(await capture('auditDatabase', () => this.auditStore.health()))
    if (this.observationStore) checks.push(await capture('observationDatabase', () => this.observationStore.health()))
    if (this.observationService) checks.push(await capture('observationScheduler', () => {
      const { settings, running, schedulerRunning, nextRunAt } = this.observationService.status()
      return { enabled: settings.enabled, running, schedulerRunning, nextRunAt }
    }))
    checks.push(await capture('subscriptionScheduler', () => this.subscriptionService
      ? { enabled: true, ...this.subscriptionService.schedulerStatus() }
      : { enabled: false }))
    checks.push(await capture('mihomoCore', async () => {
      if (!this.embeddedCore) return { enabled: false }
      const status = await this.embeddedCoreStatus()
      if (!status.reachable) throw new Error(status.error || 'Mihomo 核心不可达')
      return status
    }))
    checks.push(await capture('catalog', async () => {
      const catalog = await this.loadLiveCatalog()
      const listeners = catalog.listeners || []
      const invalidListeners = listeners.filter(item => String(item.lastChecked || '').includes('节点已不存在'))
      if (invalidListeners.length) throw new Error(`${invalidListeners.length} 个端口引用了已不存在的节点`)
      return { subscriptions: catalog.providers.length, nodes: catalog.nodes.length, listeners: listeners.length }
    }))
    checks.push(await capture('storage', async () => {
      const directories = uniqueDirectories(this.dataFiles)
      const values = []
      for (const directory of directories) {
        await access(directory, fsConstants.R_OK | fsConstants.W_OK)
        const info = await statfs(directory)
        values.push({
          directory: path.basename(directory) || directory,
          writable: true,
          freeBytes: Number(info.bavail) * Number(info.bsize),
          totalBytes: Number(info.blocks) * Number(info.bsize),
        })
      }
      return { directories: values }
    }))
    const errors = checks.filter(item => item.status === 'error').length
    const warnings = checks.filter(item => item.status === 'warning').length
    return {
      status: errors ? 'error' : warnings ? 'warning' : 'ok',
      checkedAt: Date.now(),
      appVersion: this.appVersion,
      deploymentMode: this.deploymentMode,
      processUptimeSeconds: Math.floor(process.uptime()),
      systemUptimeSeconds: Math.floor(os.uptime()),
      startedAt: this.startedAt,
      errors,
      warnings,
      checks,
    }
  }

  async export() {
    const diagnostics = await this.run()
    const subscriptions = this.subscriptionStore?.list().map(item => ({
      id: item.id,
      name: item.name,
      sourceType: item.sourceType,
      enabled: item.enabled,
      priority: item.priority,
      nodeCount: item.nodeCount,
      lastAttemptAt: item.lastAttemptAt,
      lastSuccessAt: item.lastSuccessAt,
      lastError: item.lastError ? redactText(item.lastError) : null,
    })) || []
    const recentFailures = this.auditStore.list({ outcome: 'failure', limit: 20 }).events
    return redactSensitive({
      format: 'ppm-diagnostics',
      version: 1,
      generatedAt: Date.now(),
      environment: {
        appVersion: this.appVersion,
        deploymentMode: this.deploymentMode,
        platform: `${os.platform()} ${os.release()}`,
        architecture: os.arch(),
        nodeVersion: process.version,
      },
      diagnostics,
      subscriptions,
      recentFailures,
    })
  }
}
