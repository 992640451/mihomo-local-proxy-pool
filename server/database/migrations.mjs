import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

function migrationVersion(migration, index) {
  const version = Number(migration?.version)
  if (!Number.isInteger(version) || version !== index + 1) {
    throw new Error(`数据库迁移版本必须从 1 连续递增，当前位置为 ${index + 1}`)
  }
  if (typeof migration.up !== 'function') throw new Error(`数据库迁移 v${version} 缺少 up 函数`)
  return version
}

function backupName(filename, version) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${filename}.backup-v${version}-${stamp}`
}

export function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(item => item.name === column)
}

export function openMigratedDatabase({
  filename = ':memory:',
  name = 'database',
  migrations = [],
  foreignKeys = false,
  journalMode = filename === ':memory:' ? null : 'WAL',
} = {}) {
  migrations.forEach(migrationVersion)
  const resolved = filename === ':memory:' ? filename : path.resolve(filename)
  const existed = resolved !== ':memory:' && existsSync(resolved) && statSync(resolved).size > 0
  if (resolved !== ':memory:') mkdirSync(path.dirname(resolved), { recursive: true })

  const db = new DatabaseSync(resolved)
  let backupFile = null
  try {
    db.exec('PRAGMA busy_timeout = 5000;')
    if (foreignKeys) db.exec('PRAGMA foreign_keys = ON;')
    const currentVersion = Number(db.prepare('PRAGMA user_version').get().user_version || 0)
    const latestVersion = migrations.length
    if (currentVersion > latestVersion) {
      throw new Error(`${name} 数据库版本 v${currentVersion} 高于当前程序支持的 v${latestVersion}`)
    }

    if (currentVersion < latestVersion && existed) {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
      backupFile = backupName(resolved, currentVersion)
      copyFileSync(resolved, backupFile)
    }

    if (currentVersion < latestVersion) {
      db.exec('BEGIN IMMEDIATE;')
      try {
        for (const migration of migrations.slice(currentVersion)) {
          migration.up(db)
          db.exec(`PRAGMA user_version = ${migration.version};`)
        }
        db.exec('COMMIT;')
      } catch (error) {
        db.exec('ROLLBACK;')
        throw new Error(`${name} 数据库迁移失败：${error.message}`, { cause: error })
      }
    }

    db.exec('PRAGMA synchronous = NORMAL;')
    if (journalMode) db.exec(`PRAGMA journal_mode = ${journalMode};`)
    return { db, backupFile, version: latestVersion }
  } catch (error) {
    db.close()
    throw error
  }
}
