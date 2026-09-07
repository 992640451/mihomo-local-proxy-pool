import { openMigratedDatabase } from '../database/migrations.mjs'
import { SecretBox } from '../subscriptions/crypto.mjs'

function now() { return Date.now() }
function text(value, maximum = 256) {
  const result = String(value ?? '').trim()
  if (!result || result.length > maximum || /[\u0000-\u001f\u007f]/.test(result)) throw new Error('Roxy 标识无效')
  return result
}

const migrations = [{
  version: 1,
  up(db) {
    db.exec(`
      CREATE TABLE roxy_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        api_port INTEGER NOT NULL,
        api_key_encrypted TEXT NOT NULL,
        connected_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE roxy_bindings (
        port INTEGER PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        project_id TEXT,
        dir_id TEXT NOT NULL,
        window_name TEXT NOT NULL,
        window_sort_num INTEGER,
        sync_proxy INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(workspace_id, dir_id)
      );
    `)
  },
}]

export class RoxyIntegrationStore {
  constructor({ filename = ':memory:', masterKey }) {
    const migrated = openMigratedDatabase({ filename, name: 'Roxy 浏览器接入', migrations })
    this.db = migrated.db
    this.schemaVersion = migrated.version
    this.box = new SecretBox(masterKey)
  }

  config({ secrets = false } = {}) {
    const row = this.db.prepare('SELECT * FROM roxy_config WHERE id=1').get()
    if (!row) return { configured: false, apiPort: 50000, hasApiKey: false, connectedAt: null, updatedAt: null }
    return {
      configured: true,
      apiPort: Number(row.api_port),
      hasApiKey: Boolean(row.api_key_encrypted),
      ...(secrets ? { apiKey: this.box.decrypt(row.api_key_encrypted) } : {}),
      connectedAt: Number(row.connected_at),
      updatedAt: Number(row.updated_at),
    }
  }

  saveConfig({ apiPort, apiKey }) {
    const current = this.config({ secrets: true })
    const key = apiKey === undefined ? current.apiKey : String(apiKey || '').trim()
    if (!key || key.length > 4096) throw new Error('请填写有效的 Roxy API Key')
    const timestamp = now()
    this.db.prepare(`INSERT INTO roxy_config(id,api_port,api_key_encrypted,connected_at,updated_at)
      VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      api_port=excluded.api_port,api_key_encrypted=excluded.api_key_encrypted,
      connected_at=excluded.connected_at,updated_at=excluded.updated_at`)
      .run(Number(apiPort), this.box.encrypt(key), timestamp, timestamp)
    return this.config()
  }

  binding(port) {
    const row = this.db.prepare('SELECT * FROM roxy_bindings WHERE port=?').get(Number(port))
    return row ? this.#binding(row) : null
  }

  bindings() {
    return this.db.prepare('SELECT * FROM roxy_bindings ORDER BY port').all().map(row => this.#binding(row))
  }

  saveBinding(port, input) {
    const numericPort = Number(port)
    if (!Number.isInteger(numericPort) || numericPort < 1024 || numericPort > 65535) throw new Error('代理端口无效')
    const binding = {
      port: numericPort,
      workspaceId: text(input.workspaceId),
      projectId: input.projectId ? text(input.projectId) : '',
      dirId: text(input.dirId),
      windowName: text(input.windowName || input.dirId),
      windowSortNum: input.windowSortNum === null || input.windowSortNum === undefined || input.windowSortNum === '' ? null : Number(input.windowSortNum),
      syncProxy: input.syncProxy !== false,
    }
    if (binding.windowSortNum !== null && !Number.isInteger(binding.windowSortNum)) throw new Error('Roxy 窗口序号无效')
    const timestamp = now(), current = this.binding(numericPort)
    try {
      this.db.prepare(`INSERT INTO roxy_bindings(port,workspace_id,project_id,dir_id,window_name,window_sort_num,sync_proxy,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(port) DO UPDATE SET
        workspace_id=excluded.workspace_id,project_id=excluded.project_id,dir_id=excluded.dir_id,
        window_name=excluded.window_name,window_sort_num=excluded.window_sort_num,
        sync_proxy=excluded.sync_proxy,updated_at=excluded.updated_at`)
        .run(numericPort, binding.workspaceId, binding.projectId || null, binding.dirId, binding.windowName,
          binding.windowSortNum, binding.syncProxy ? 1 : 0, current?.createdAt || timestamp, timestamp)
    } catch (error) {
      if (String(error.message).includes('UNIQUE constraint failed')) throw Object.assign(new Error('此 Roxy 窗口已绑定到其他代理端口'), { code: 'ROXY_WINDOW_ALREADY_BOUND', status: 409 })
      throw error
    }
    return this.binding(numericPort)
  }

  deleteBinding(port) { return this.db.prepare('DELETE FROM roxy_bindings WHERE port=?').run(Number(port)).changes > 0 }

  #binding(row) {
    return {
      port: Number(row.port), workspaceId: row.workspace_id, projectId: row.project_id || '', dirId: row.dir_id,
      windowName: row.window_name, windowSortNum: row.window_sort_num === null ? null : Number(row.window_sort_num),
      syncProxy: Boolean(row.sync_proxy), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    }
  }

  health() { return { ok: true, schemaVersion: this.schemaVersion, configured: this.config().configured, bindings: this.bindings().length } }
  close() { this.db.close() }
}
