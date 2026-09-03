import { randomUUID } from 'node:crypto'
import { hasColumn, openMigratedDatabase } from '../database/migrations.mjs'
import { SecretBox } from './crypto.mjs'
import { redactText } from '../security/redaction.mjs'

function now() { return Date.now() }
function bool(value) { return value ? 1 : 0 }

const subscriptionMigrations = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS subscriptions (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, source_type TEXT NOT NULL,
          url_encrypted TEXT, enabled INTEGER NOT NULL DEFAULT 1,
          priority INTEGER NOT NULL DEFAULT 0,
          refresh_interval_seconds INTEGER NOT NULL DEFAULT 3600,
          etag TEXT, last_modified TEXT, active_snapshot_id TEXT,
          last_attempt_at INTEGER, last_success_at INTEGER, last_error TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS subscription_snapshots (
          id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
          content_encrypted TEXT NOT NULL, content_hash TEXT NOT NULL, format TEXT NOT NULL,
          node_count INTEGER NOT NULL, status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS subscription_nodes (
          id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
          stable_key TEXT NOT NULL, name TEXT NOT NULL, raw_encrypted TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1, orphaned_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          UNIQUE(subscription_id, stable_key)
        );
        CREATE INDEX IF NOT EXISTS subscription_nodes_subscription_idx ON subscription_nodes(subscription_id, active);
      `)
      if (!hasColumn(db, 'subscriptions', 'priority')) {
        db.exec('ALTER TABLE subscriptions ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;')
      }
    },
  },
]

export class SubscriptionStore {
  constructor({ filename = ':memory:', masterKey }) {
    this.filename = filename
    const migrated = openMigratedDatabase({
      filename,
      name: '订阅',
      migrations: subscriptionMigrations,
      foreignKeys: true,
    })
    this.db = migrated.db
    this.migrationBackupFile = migrated.backupFile
    this.schemaVersion = migrated.version
    this.box = new SecretBox(masterKey)
  }

  insertSubscription({ id = randomUUID(), name, sourceType, url = null, enabled = true, priority = 0, refreshIntervalSeconds = 3600 }) {
    const timestamp = now()
    this.db.prepare(`INSERT INTO subscriptions
      (id,name,source_type,url_encrypted,enabled,priority,refresh_interval_seconds,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(id, name, sourceType, this.box.encrypt(url), bool(enabled), priority, refreshIntervalSeconds, timestamp, timestamp)
    return id
  }

  get(id, { secrets = false } = {}) {
    const row = this.db.prepare('SELECT * FROM subscriptions WHERE id=?').get(id)
    return row ? this.#subscription(row, secrets) : null
  }

  list({ secrets = false } = {}) {
    return this.db.prepare('SELECT * FROM subscriptions ORDER BY priority DESC,created_at,id').all().map(row => this.#subscription(row, secrets))
  }

  #subscription(row, secrets) {
    const url = row.url_encrypted ? this.box.decrypt(row.url_encrypted) : null
    return {
      id: row.id, name: row.name, sourceType: row.source_type,
      url: secrets ? url : (url ? maskUrl(url) : null), enabled: Boolean(row.enabled),
      priority: Number(row.priority || 0),
      refreshIntervalSeconds: row.refresh_interval_seconds, etag: row.etag, lastModified: row.last_modified,
      activeSnapshotId: row.active_snapshot_id, lastAttemptAt: row.last_attempt_at, lastSuccessAt: row.last_success_at,
      lastError: row.last_error ? redactText(row.last_error) : null, createdAt: row.created_at, updatedAt: row.updated_at,
      nodeCount: Number(this.db.prepare('SELECT count(*) count FROM subscription_nodes WHERE subscription_id=? AND active=1').get(row.id).count),
    }
  }

  update(id, patch) {
    const current = this.get(id, { secrets: true })
    if (!current) throw new Error('订阅不存在')
    const name = patch.name === undefined ? current.name : String(patch.name).trim()
    const url = patch.url === undefined ? current.url : patch.url
    const enabled = patch.enabled === undefined ? current.enabled : patch.enabled !== false
    const priority = patch.priority === undefined ? current.priority : Number(patch.priority)
    const interval = patch.refreshIntervalSeconds === undefined ? current.refreshIntervalSeconds : Number(patch.refreshIntervalSeconds)
    this.db.prepare(`UPDATE subscriptions SET name=?,url_encrypted=?,enabled=?,priority=?,refresh_interval_seconds=?,updated_at=? WHERE id=?`)
      .run(name, this.box.encrypt(url), bool(enabled), priority, interval, now(), id)
  }

  recordFailure(id, message) {
    this.db.prepare('UPDATE subscriptions SET last_attempt_at=?,last_error=?,updated_at=? WHERE id=?').run(now(), redactText(message), now(), id)
  }

  recordNotModified(id, { etag, lastModified }) {
    const timestamp = now()
    this.db.prepare('UPDATE subscriptions SET etag=?,last_modified=?,last_attempt_at=?,last_success_at=?,last_error=NULL,updated_at=? WHERE id=?')
      .run(etag, lastModified, timestamp, timestamp, timestamp, id)
  }

  activate({ subscriptionId, content, contentHash, format, nodes, etag = null, lastModified = null, preferredId }) {
    const snapshotId = randomUUID(), timestamp = now()
    const encryptedContent = this.box.encrypt(content)
    const encryptedNodes = nodes.map(node => ({ ...node, rawEncrypted: this.box.encrypt(JSON.stringify(node.raw)) }))
    this.db.exec('SAVEPOINT subscription_activate')
    try {
      this.db.prepare(`INSERT INTO subscription_snapshots
        (id,subscription_id,content_encrypted,content_hash,format,node_count,status,created_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(snapshotId, subscriptionId, encryptedContent, contentHash, format, nodes.length, 'ACTIVE', timestamp)
      this.db.prepare("UPDATE subscription_snapshots SET status='SUPERSEDED' WHERE subscription_id=? AND id<>? AND status='ACTIVE'").run(subscriptionId, snapshotId)
      this.db.prepare('UPDATE subscription_nodes SET active=0,orphaned_at=?,updated_at=? WHERE subscription_id=?').run(timestamp, timestamp, subscriptionId)
      const existingStatement = this.db.prepare('SELECT id FROM subscription_nodes WHERE subscription_id=? AND stable_key=?')
      const insertStatement = this.db.prepare(`INSERT INTO subscription_nodes
        (id,subscription_id,stable_key,name,raw_encrypted,active,orphaned_at,created_at,updated_at)
        VALUES (?,?,?,?,?,1,NULL,?,?)`)
      const updateStatement = this.db.prepare('UPDATE subscription_nodes SET name=?,raw_encrypted=?,active=1,orphaned_at=NULL,updated_at=? WHERE id=?')
      for (const node of encryptedNodes) {
        const existing = existingStatement.get(subscriptionId, node.stableKey)
        if (existing) updateStatement.run(node.name, node.rawEncrypted, timestamp, existing.id)
        else insertStatement.run(preferredId?.(node) || node.id, subscriptionId, node.stableKey, node.name, node.rawEncrypted, timestamp, timestamp)
      }
      this.db.prepare(`UPDATE subscriptions SET active_snapshot_id=?,etag=?,last_modified=?,last_attempt_at=?,last_success_at=?,last_error=NULL,updated_at=? WHERE id=?`)
        .run(snapshotId, etag, lastModified, timestamp, timestamp, timestamp, subscriptionId)
      this.db.exec('RELEASE subscription_activate')
    } catch (error) { this.db.exec('ROLLBACK TO subscription_activate; RELEASE subscription_activate'); throw error }
    return snapshotId
  }

  // Called only under SubscriptionService's queue and the shared core write lock.
  // The core sees candidate definitions, but SQLite does not commit until reload succeeds.
  async transaction(operation) {
    this.db.exec('SAVEPOINT subscription_change')
    try {
      const result = await operation()
      this.db.exec('RELEASE subscription_change')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK TO subscription_change; RELEASE subscription_change')
      throw error
    }
  }

  definitions({ includeOrphaned = false, includeDisabled = false } = {}) {
    const rows = this.db.prepare(`SELECT n.*,s.name provider,s.enabled subscription_enabled,s.priority subscription_priority FROM subscription_nodes n
      JOIN subscriptions s ON s.id=n.subscription_id
      WHERE 1=1 ${includeDisabled ? '' : 'AND s.enabled=1'} ${includeOrphaned ? '' : 'AND n.active=1'} ORDER BY s.priority DESC,s.created_at,n.created_at`).all()
    return rows.map(row => ({
      id: row.id, providerId: row.subscription_id, provider: row.provider,
      raw: JSON.parse(this.box.decrypt(row.raw_encrypted)), active: Boolean(row.active), subscriptionEnabled: Boolean(row.subscription_enabled),
    }))
  }

  nodeIds(id) { return this.db.prepare('SELECT id FROM subscription_nodes WHERE subscription_id=?').all(id).map(row => row.id) }

  exportRecovery() {
    return this.db.prepare('SELECT * FROM subscriptions ORDER BY created_at,id').all().map(row => {
      const snapshot = row.active_snapshot_id
        ? this.db.prepare('SELECT * FROM subscription_snapshots WHERE id=?').get(row.active_snapshot_id)
        : null
      const nodes = this.db.prepare('SELECT * FROM subscription_nodes WHERE subscription_id=? ORDER BY created_at,id').all(row.id)
      return {
        id: row.id,
        name: row.name,
        sourceType: row.source_type,
        url: row.url_encrypted ? this.box.decrypt(row.url_encrypted) : null,
        enabled: Boolean(row.enabled),
        priority: Number(row.priority || 0),
        refreshIntervalSeconds: Number(row.refresh_interval_seconds),
        etag: row.etag,
        lastModified: row.last_modified,
        lastAttemptAt: row.last_attempt_at,
        lastSuccessAt: row.last_success_at,
        lastError: row.last_error,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        snapshot: snapshot ? {
          id: snapshot.id,
          content: this.box.decrypt(snapshot.content_encrypted),
          contentHash: snapshot.content_hash,
          format: snapshot.format,
          nodeCount: Number(snapshot.node_count),
          createdAt: Number(snapshot.created_at),
        } : null,
        nodes: nodes.map(node => ({
          id: node.id,
          stableKey: node.stable_key,
          name: node.name,
          raw: JSON.parse(this.box.decrypt(node.raw_encrypted)),
          active: Boolean(node.active),
          orphanedAt: node.orphaned_at,
          createdAt: Number(node.created_at),
          updatedAt: Number(node.updated_at),
        })),
      }
    })
  }

  replaceRecovery(subscriptions) {
    if (!Array.isArray(subscriptions)) throw new Error('恢复数据中的订阅列表无效')
    const prepared = subscriptions.map(item => ({
      ...item,
      urlEncrypted: this.box.encrypt(item.url || null),
      snapshot: item.snapshot ? { ...item.snapshot, contentEncrypted: this.box.encrypt(item.snapshot.content) } : null,
      nodes: (item.nodes || []).map(node => ({ ...node, rawEncrypted: this.box.encrypt(JSON.stringify(node.raw)) })),
    }))
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.exec('DELETE FROM subscriptions;')
      const insertSubscription = this.db.prepare(`INSERT INTO subscriptions(
        id,name,source_type,url_encrypted,enabled,priority,refresh_interval_seconds,etag,last_modified,
        active_snapshot_id,last_attempt_at,last_success_at,last_error,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      const insertSnapshot = this.db.prepare(`INSERT INTO subscription_snapshots(
        id,subscription_id,content_encrypted,content_hash,format,node_count,status,error,created_at
      ) VALUES (?,?,?,?,?,?,? ,NULL,?)`)
      const insertNode = this.db.prepare(`INSERT INTO subscription_nodes(
        id,subscription_id,stable_key,name,raw_encrypted,active,orphaned_at,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?)`)
      for (const item of prepared) {
        insertSubscription.run(
          item.id, item.name, item.sourceType, item.urlEncrypted, bool(item.enabled), Number(item.priority || 0),
          Number(item.refreshIntervalSeconds || 3600), item.etag || null, item.lastModified || null,
          item.snapshot?.id || null, item.lastAttemptAt || null, item.lastSuccessAt || null, item.lastError || null,
          Number(item.createdAt || now()), Number(item.updatedAt || now()),
        )
        if (item.snapshot) {
          insertSnapshot.run(
            item.snapshot.id, item.id, item.snapshot.contentEncrypted, item.snapshot.contentHash,
            item.snapshot.format, Number(item.snapshot.nodeCount), 'ACTIVE', Number(item.snapshot.createdAt || now()),
          )
        }
        for (const node of item.nodes) {
          insertNode.run(
            node.id, item.id, node.stableKey, node.name, node.rawEncrypted, bool(node.active), node.orphanedAt || null,
            Number(node.createdAt || now()), Number(node.updatedAt || now()),
          )
        }
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return { subscriptions: prepared.length, nodes: prepared.reduce((sum, item) => sum + item.nodes.length, 0) }
  }

  health() {
    const subscriptions = Number(this.db.prepare('SELECT count(*) count FROM subscriptions').get().count)
    const nodes = Number(this.db.prepare('SELECT count(*) count FROM subscription_nodes WHERE active=1').get().count)
    return { ok: true, schemaVersion: this.schemaVersion, subscriptions, activeNodes: nodes }
  }

  delete(id) { this.db.prepare('DELETE FROM subscriptions WHERE id=?').run(id) }
  close() { this.db.close() }
}

export function maskUrl(raw) {
  try {
    const url = new URL(raw)
    url.username = ''; url.password = ''
    if (url.hash) url.hash = '#***'
    const keys = [...url.searchParams.keys()]
    for (const key of keys) url.searchParams.set(key, '***')
    const parts = url.pathname.split('/')
    const last = parts.map((part, index) => part ? index : -1).filter(index => index >= 0).at(-1)
    if (last !== undefined) parts[last] = '***'
    url.pathname = parts.join('/')
    return url.toString()
  } catch { return '***' }
}
