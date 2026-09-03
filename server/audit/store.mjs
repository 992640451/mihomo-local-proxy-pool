import { randomUUID } from 'node:crypto'
import { openMigratedDatabase } from '../database/migrations.mjs'
import { redactSensitive, redactText } from '../security/redaction.mjs'

const auditMigrations = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE audit_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          actor TEXT NOT NULL,
          action TEXT NOT NULL,
          outcome TEXT NOT NULL,
          target_type TEXT,
          target_id TEXT,
          message TEXT NOT NULL,
          request_id TEXT,
          duration_ms INTEGER,
          metadata_json TEXT
        );
        CREATE INDEX idx_audit_events_created_at ON audit_events(created_at DESC);
        CREATE INDEX idx_audit_events_action ON audit_events(action, created_at DESC);
        CREATE INDEX idx_audit_events_outcome ON audit_events(outcome, created_at DESC);
      `)
    },
  },
]

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const numeric = Number(value)
  return Number.isInteger(numeric) && numeric > 0 ? Math.min(numeric, maximum) : fallback
}

function eventFromRow(row) {
  return redactSensitive({
    id: Number(row.id),
    eventId: row.event_id,
    createdAt: Number(row.created_at),
    actor: row.actor,
    action: row.action,
    outcome: row.outcome,
    targetType: row.target_type,
    targetId: row.target_id,
    message: row.message,
    requestId: row.request_id,
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
  })
}

export class AuditStore {
  constructor({ filename = ':memory:', retentionDays = 30, maxEvents = 10_000 } = {}) {
    this.filename = filename
    this.retentionDays = positiveInteger(retentionDays, 30, 3650)
    this.maxEvents = positiveInteger(maxEvents, 10_000, 1_000_000)
    const migrated = openMigratedDatabase({ filename, name: '审计', migrations: auditMigrations })
    this.db = migrated.db
    this.schemaVersion = migrated.version
    this.migrationBackupFile = migrated.backupFile
    this.insertStatement = this.db.prepare(`
      INSERT INTO audit_events(
        event_id, created_at, actor, action, outcome, target_type, target_id,
        message, request_id, duration_ms, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.prune()
  }

  record({
    actor = 'local',
    action,
    outcome = 'success',
    targetType = null,
    targetId = null,
    message,
    requestId = null,
    durationMs = null,
    metadata = null,
    createdAt = Date.now(),
  } = {}) {
    const cleanAction = String(action || '').trim()
    const cleanMessage = redactText(String(message || cleanAction || '操作完成'))
    if (!cleanAction) throw new Error('审计事件缺少 action')
    if (!['success', 'failure'].includes(outcome)) throw new Error('审计事件 outcome 无效')
    const result = this.insertStatement.run(
      randomUUID(),
      Number(createdAt),
      redactText(String(actor || 'local')),
      cleanAction,
      outcome,
      targetType ? String(targetType) : null,
      targetId ? redactText(String(targetId)) : null,
      cleanMessage,
      requestId ? String(requestId) : null,
      Number.isFinite(Number(durationMs)) ? Math.max(0, Math.round(Number(durationMs))) : null,
      metadata ? JSON.stringify(redactSensitive(metadata)) : null,
    )
    if (Number(result.lastInsertRowid) % 100 === 0) this.prune()
    return this.get(Number(result.lastInsertRowid))
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM audit_events WHERE id = ?').get(Number(id))
    return row ? eventFromRow(row) : null
  }

  list({ before, limit = 100, outcome, action } = {}) {
    const clauses = [], values = []
    const numericBefore = Number(before)
    if (Number.isInteger(numericBefore) && numericBefore > 0) { clauses.push('id < ?'); values.push(numericBefore) }
    if (['success', 'failure'].includes(outcome)) { clauses.push('outcome = ?'); values.push(outcome) }
    if (action) { clauses.push('action = ?'); values.push(String(action)) }
    const safeLimit = positiveInteger(limit, 100, 200)
    values.push(safeLimit + 1)
    const rows = this.db.prepare(`
      SELECT * FROM audit_events
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY id DESC LIMIT ?
    `).all(...values)
    const hasMore = rows.length > safeLimit
    const events = rows.slice(0, safeLimit).map(eventFromRow)
    return { events, hasMore, nextBefore: hasMore ? events.at(-1)?.id || null : null }
  }

  clear() {
    return Number(this.db.prepare('DELETE FROM audit_events').run().changes)
  }

  prune(now = Date.now()) {
    const cutoff = Number(now) - this.retentionDays * 24 * 60 * 60 * 1000
    const expired = Number(this.db.prepare('DELETE FROM audit_events WHERE created_at < ?').run(cutoff).changes)
    const overflow = Number(this.db.prepare(`
      DELETE FROM audit_events WHERE id NOT IN (
        SELECT id FROM audit_events ORDER BY id DESC LIMIT ?
      )
    `).run(this.maxEvents).changes)
    return expired + overflow
  }

  health() {
    const row = this.db.prepare('SELECT count(*) count, max(created_at) latest FROM audit_events').get()
    return { ok: true, schemaVersion: this.schemaVersion, eventCount: Number(row.count), latestEventAt: row.latest ? Number(row.latest) : null }
  }

  close() { this.db.close() }
}
