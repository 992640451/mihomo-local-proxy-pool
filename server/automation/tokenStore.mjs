import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { openMigratedDatabase } from '../database/migrations.mjs'
import { normalizeApiScopes } from '../../shared/apiScopes.js'

const digest = value => createHash('sha256').update(value).digest('hex')
const metadata = row => ({
  id: row.id, name: row.name, scopes: JSON.parse(row.scopes), createdAt: row.created_at,
  expiresAt: row.expires_at, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at,
})

export class ApiTokenStore {
  constructor({ filename = ':memory:', credentialVersion } = {}) {
    this.credentialVersion = credentialVersion
    const migrated = openMigratedDatabase({ filename, name: 'API 令牌', migrations: [{ version: 1, up(db) {
      db.exec(`CREATE TABLE api_tokens (
        id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE, name TEXT NOT NULL, scopes TEXT NOT NULL,
        credential_version TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        last_used_at INTEGER, revoked_at INTEGER
      );`)
    } }] })
    this.db = migrated.db
    this.schemaVersion = migrated.version
    // Changing admin credentials invalidates automation credentials as well.
    this.db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE credential_version <> ? AND revoked_at IS NULL').run(Date.now(), credentialVersion)
  }

  list() { return this.db.prepare('SELECT * FROM api_tokens ORDER BY created_at DESC, id').all().map(metadata) }

  create({ name, scopes, expiresInDays = 90 } = {}, now = Date.now()) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80 || /[\r\n\x00-\x1f]/.test(name)) throw new Error('令牌名称须为 1–80 个字符')
    scopes = normalizeApiScopes(scopes)
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) throw new Error('有效期须为 1–365 天')
    const active = this.db.prepare('SELECT count(*) count FROM api_tokens WHERE revoked_at IS NULL AND expires_at > ?').get(now).count
    if (active >= 100) throw new Error('最多允许 100 个有效令牌，请先撤销不再使用的令牌')
    // Bound inactive history without deleting any active credentials.
    this.db.prepare(`DELETE FROM api_tokens WHERE id IN (SELECT id FROM api_tokens WHERE revoked_at IS NOT NULL OR expires_at <= ? ORDER BY created_at DESC LIMIT -1 OFFSET 900)`).run(now)
    const id = randomUUID(), secret = `ppm_${randomBytes(32).toString('base64url')}`
    this.db.prepare('INSERT INTO api_tokens(id,digest,name,scopes,credential_version,created_at,expires_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, digest(secret), name.trim(), JSON.stringify(scopes), this.credentialVersion, now, now + expiresInDays * 86400000)
    return { ...metadata(this.db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(id)), secret }
  }

  authenticate(secret, now = Date.now()) {
    if (typeof secret !== 'string' || !/^ppm_[A-Za-z0-9_-]{43}$/.test(secret)) return null
    const row = this.db.prepare('SELECT * FROM api_tokens WHERE digest = ?').get(digest(secret))
    if (!row || row.revoked_at !== null || row.expires_at <= now || row.credential_version !== this.credentialVersion) return null
    // Coalesce frequent polling writes; the first authenticated use is always recorded.
    if (row.last_used_at === null || now - row.last_used_at >= 60000) this.db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now, row.id)
    return metadata(row)
  }

  revoke(id, now = Date.now()) { return this.db.prepare('UPDATE api_tokens SET revoked_at = coalesce(revoked_at, ?) WHERE id = ?').run(now, id).changes > 0 }
  health() { return { ok: true, schemaVersion: this.schemaVersion, entries: this.db.prepare('SELECT count(*) count FROM api_tokens').get().count } }
  close() { this.db.close() }
}
