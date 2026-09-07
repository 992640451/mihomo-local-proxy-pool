import { randomUUID, createHash } from 'node:crypto'
import { openMigratedDatabase } from './database/migrations.mjs'

export const SESSION_STRATEGY = 'session-round-robin'
export function sessionError(message, code = 'PROXY_SESSION_CONFLICT', status = 409) {
  return Object.assign(new Error(message), { code, status })
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
export const nodeFingerprint = raw => createHash('sha256').update(JSON.stringify(canonical(raw))).digest('hex')
export function publicSession(record) {
  if (!record) return null
  const { nodeFingerprint: _fingerprint, ...result } = record
  return result
}

export class ProxySessionStore {
  constructor({ filename = ':memory:' } = {}) {
    this.db = openMigratedDatabase({ filename, name: '代理使用会话', migrations: [{ version: 1, up(db) {
      db.exec(`CREATE TABLE proxy_sessions (
        session_id TEXT PRIMARY KEY, port INTEGER NOT NULL, launch_id TEXT NOT NULL,
        state TEXT NOT NULL, record TEXT NOT NULL, UNIQUE(port, launch_id));
        CREATE UNIQUE INDEX proxy_session_open ON proxy_sessions(port) WHERE state != 'ended';
        CREATE TABLE proxy_session_cursor (port INTEGER PRIMARY KEY, node_id TEXT NOT NULL);`)
    } }] }).db
    // A committed binding must survive a power loss before acknowledging a launch.
    this.db.exec('PRAGMA synchronous = FULL;')
  }
  parse(row) { return row ? JSON.parse(row.record) : null }
  current(port) { return this.parse(this.db.prepare("SELECT record FROM proxy_sessions WHERE port=? AND state!='ended'").get(Number(port))) }
  find(port, launchId) { return this.parse(this.db.prepare('SELECT record FROM proxy_sessions WHERE port=? AND launch_id=?').get(Number(port), launchId)) }
  byId(port, id) { return this.parse(this.db.prepare('SELECT record FROM proxy_sessions WHERE port=? AND session_id=?').get(Number(port), id)) }
  openSessions() { return this.db.prepare("SELECT record FROM proxy_sessions WHERE state!='ended' ORDER BY rowid").all().map(row => this.parse(row)) }
  lastNode(port) { return this.db.prepare('SELECT node_id FROM proxy_session_cursor WHERE port=?').get(Number(port))?.node_id || null }
  assertIdle(port) {
    const open = port === undefined
      ? this.db.prepare("SELECT port FROM proxy_sessions WHERE state!='ended' LIMIT 1").get()
      : this.current(port)
    if (open) throw sessionError(`端口 ${open.port} 有未结束的代理会话，请先结束使用`)
  }
  create(port, launchId, profileId) {
    const record = { port: Number(port), sessionId: randomUUID(), launchId, profileId, state: 'preparing', nodeId: null,
      nodeName: null, nodeFingerprint: null, startedAt: null, endedAt: null, createdAt: Date.now(), error: null }
    this.db.prepare('INSERT INTO proxy_sessions VALUES(?,?,?,?,?)').run(record.sessionId, record.port, launchId, record.state, JSON.stringify(record))
    return record
  }
  save(record) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('UPDATE proxy_sessions SET state=?, record=? WHERE session_id=?').run(record.state, JSON.stringify(record), record.sessionId)
      if (record.state === 'active') this.db.prepare('INSERT INTO proxy_session_cursor VALUES(?,?) ON CONFLICT(port) DO UPDATE SET node_id=excluded.node_id').run(record.port, record.nodeId)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return record
  }
  recoverInterrupted() {
    for (const row of this.db.prepare("SELECT record FROM proxy_sessions WHERE state NOT IN ('active','ended','recovery-required')").all()) {
      this.save({ ...this.parse(row), state: 'recovery-required', error: '上次操作被中断，请先结束此会话，再重新开始使用' })
    }
  }
  close() { this.db.close() }
}
