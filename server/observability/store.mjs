import { openMigratedDatabase } from '../database/migrations.mjs'
import { redactSensitive } from '../security/redaction.mjs'
import { OBSERVABILITY_DEFAULTS, validateObservabilitySettings } from '../../shared/observability.js'

const migrations = [{ version: 1, up(db) {
  db.exec(`CREATE TABLE observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, target_id TEXT NOT NULL,
    created_at INTEGER NOT NULL, attempts INTEGER NOT NULL, successes INTEGER NOT NULL,
    latency_ms INTEGER, payload_json TEXT NOT NULL
  );
  CREATE INDEX observation_target ON observations(kind, target_id, id DESC);
  CREATE INDEX observation_time ON observations(created_at);
  CREATE TABLE observation_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
} }]

function fromRow(row) {
  return row ? { id: Number(row.id), kind: row.kind, targetId: row.target_id, checkedAt: row.created_at,
    attempts: row.attempts, successes: row.successes, failures: row.attempts - row.successes,
    latencyMs: row.latency_ms, ...JSON.parse(row.payload_json) } : null
}

export class ObservationStore {
  constructor({ filename = ':memory:' } = {}) {
    this.filename = filename
    const migrated = openMigratedDatabase({ filename, name: '可观测性', migrations })
    this.db = migrated.db
    this.schemaVersion = migrated.version
    this.settings = validateObservabilitySettings(this.meta('settings') || {}, OBSERVABILITY_DEFAULTS)
    const job = this.meta('job')
    if (job?.status === 'running') this.setMeta('job', { ...job, status: 'interrupted', finishedAt: Date.now(), error: '服务重启，未完成的检测未计为节点失败' })
    this.prune()
  }

  meta(key) { const row = this.db.prepare('SELECT value FROM observation_meta WHERE key=?').get(key); return row ? JSON.parse(row.value) : null }
  setMeta(key, value) { this.db.prepare('INSERT OR REPLACE INTO observation_meta(key,value) VALUES (?,?)').run(key, JSON.stringify(redactSensitive(value))) }
  updateSettings(patch) {
    const settings = validateObservabilitySettings(patch, this.settings)
    this.setMeta('settings', settings)
    this.settings = settings
    this.prune()
    return this.settings
  }
  record({ kind, targetId, checkedAt = Date.now(), attempts = 1, successes, latencyMs = null, ...payload }) {
    if (!['node', 'port'].includes(kind) || !targetId || !Number.isInteger(attempts) || attempts < 1 || attempts > 20 || !Number.isInteger(successes) || successes < 0 || successes > attempts) throw new Error('检测结果无效')
    const json = JSON.stringify(redactSensitive(payload))
    if (Buffer.byteLength(json) > 32768) throw new Error('检测结果超过容量上限')
    const result = this.db.prepare('INSERT INTO observations(kind,target_id,created_at,attempts,successes,latency_ms,payload_json) VALUES (?,?,?,?,?,?,?)')
      .run(kind, String(targetId), checkedAt, attempts, successes, Number.isFinite(latencyMs) ? Math.max(0, Math.round(latencyMs)) : null, json)
    this.prune()
    return Number(result.lastInsertRowid)
  }
  latest(kind) {
    return this.db.prepare(`SELECT * FROM observations WHERE id IN (SELECT max(id) FROM observations WHERE kind=? GROUP BY target_id)`).all(kind).map(fromRow)
  }
  history({ kind = 'port', targetId, before, limit = 50 } = {}) {
    if (!['node', 'port'].includes(kind)) throw new Error('检测类型无效')
    const clauses = ['kind=?'], values = [kind]
    if (targetId) { clauses.push('target_id=?'); values.push(String(targetId)) }
    if (Number.isSafeInteger(Number(before)) && Number(before) > 0) { clauses.push('id<?'); values.push(Number(before)) }
    const size = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 100) : 50
    const rows = this.db.prepare(`SELECT * FROM observations WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...values, size + 1)
    const items = rows.slice(0, size).map(fromRow)
    return { items, nextBefore: rows.length > size ? items.at(-1).id : null }
  }
  summary(kind = 'port', targetId = null, now = Date.now()) {
    const since = now - 86400000
    const rows = this.db.prepare(`SELECT * FROM observations WHERE kind=? ${targetId ? 'AND target_id=?' : ''} ORDER BY id DESC`).all(kind, ...(targetId ? [String(targetId)] : []))
    let consecutiveFailures = 0
    if (targetId) for (const row of rows) { if (row.successes === row.attempts) break; consecutiveFailures++ }
    const recent = rows.filter(row => row.created_at >= since)
    const attempts = recent.reduce((n, row) => n + row.attempts, 0), successes = recent.reduce((n, row) => n + row.successes, 0)
    const start = Math.floor(now / 3600000) * 3600000 - 23 * 3600000
    const trend = Array.from({ length: 24 }, (_, i) => ({ at: start + i * 3600000, attempts: 0, failures: 0 }))
    for (const row of recent) {
      const bucket = trend[Math.floor((row.created_at - start) / 3600000)]
      if (bucket) { bucket.attempts += row.attempts; bucket.failures += row.attempts - row.successes }
    }
    return { attempts, successes, failures: attempts - successes, successRate: attempts ? Math.round(1000 * successes / attempts) / 10 : null,
      checks: recent.length, consecutiveFailures, latest: fromRow(rows[0]), trend }
  }
  prune(now = Date.now()) {
    this.db.prepare('DELETE FROM observations WHERE created_at < ?').run(now - this.settings.retentionDays * 86400000)
    this.db.prepare('DELETE FROM observations WHERE id <= COALESCE((SELECT id FROM observations ORDER BY id DESC LIMIT 1 OFFSET ?),0)').run(this.settings.maxSamples)
  }
  health() { return { ok: true, schemaVersion: this.schemaVersion, sampleCount: this.db.prepare('SELECT count(*) n FROM observations').get().n } }
  close() { this.db.close() }
}
