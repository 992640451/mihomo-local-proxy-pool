import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

function tokenHash(token) {
  return createHash('sha256').update(String(token || '')).digest('hex')
}

function toSession(row) {
  if (!row) return null
  return {
    username: row.username,
    createdAt: Number(row.created_at),
    lastSeenAt: Number(row.last_seen_at),
    absoluteExpiresAt: Number(row.absolute_expires_at),
    idleTimeoutMs: Number(row.idle_timeout_ms),
  }
}

export function createCredentialVersion(username, passwordHash, configuredVersion = '1') {
  return createHash('sha256')
    .update(`${username}\0${passwordHash}\0${configuredVersion}`)
    .digest('hex')
}

export class SessionStore {
  constructor({
    filename = ':memory:',
    idleMs,
    absoluteMs,
    touchIntervalMs = 300_000,
    credentialVersion,
  }) {
    if (filename !== ':memory:') mkdirSync(path.dirname(path.resolve(filename)), { recursive: true })
    this.filename = filename
    this.idleMs = idleMs
    this.absoluteMs = absoluteMs
    this.touchIntervalMs = Math.max(1_000, Math.min(touchIntervalMs, Math.floor(idleMs / 2)))
    this.credentialVersion = credentialVersion
    this.db = new DatabaseSync(filename)
    this.db.exec('PRAGMA busy_timeout = 5000;')
    if (filename !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec(`
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        credential_version TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        absolute_expires_at INTEGER NOT NULL,
        idle_timeout_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(absolute_expires_at);
    `)
    const columns = this.db.prepare('PRAGMA table_info(sessions)').all()
    if (!columns.some(column => column.name === 'idle_timeout_ms')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN idle_timeout_ms INTEGER;')
      this.db.prepare('UPDATE sessions SET idle_timeout_ms = ? WHERE idle_timeout_ms IS NULL').run(this.idleMs)
    }
    this.selectStatement = this.db.prepare(`
      SELECT username, credential_version, created_at, last_seen_at, absolute_expires_at, idle_timeout_ms
      FROM sessions WHERE token_hash = ?
    `)
    this.insertStatement = this.db.prepare(`
      INSERT INTO sessions(token_hash, username, credential_version, created_at, last_seen_at, absolute_expires_at, idle_timeout_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    this.touchStatement = this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?')
    this.deleteStatement = this.db.prepare('DELETE FROM sessions WHERE token_hash = ?')
    this.pruneStatement = this.db.prepare(`
      DELETE FROM sessions
      WHERE absolute_expires_at <= ? OR last_seen_at + idle_timeout_ms <= ? OR credential_version <> ?
    `)
    this.prune()
  }

  create(token, username, now = Date.now(), { idleMs = this.idleMs, absoluteMs = this.absoluteMs } = {}) {
    const session = {
      username,
      createdAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: now + absoluteMs,
      idleTimeoutMs: idleMs,
    }
    this.insertStatement.run(
      tokenHash(token),
      username,
      this.credentialVersion,
      session.createdAt,
      session.lastSeenAt,
      session.absoluteExpiresAt,
      session.idleTimeoutMs,
    )
    return session
  }

  find(token, { touch = false, now = Date.now() } = {}) {
    if (!token) return null
    const hash = tokenHash(token)
    const row = this.selectStatement.get(hash)
    if (!row) return null
    const expired = now >= Number(row.absolute_expires_at) || now - Number(row.last_seen_at) >= Number(row.idle_timeout_ms)
    if (expired || row.credential_version !== this.credentialVersion) {
      this.deleteStatement.run(hash)
      return null
    }
    if (touch && now - Number(row.last_seen_at) >= this.touchIntervalMs) {
      this.touchStatement.run(now, hash)
      row.last_seen_at = now
    }
    return toSession(row)
  }

  delete(token) {
    if (!token) return false
    return this.deleteStatement.run(tokenHash(token)).changes > 0
  }

  prune(now = Date.now()) {
    return this.pruneStatement.run(now, now, this.credentialVersion).changes
  }

  close() {
    this.db.close()
  }
}
