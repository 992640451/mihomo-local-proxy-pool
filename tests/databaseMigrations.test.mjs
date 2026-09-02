import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { openMigratedDatabase } from '../server/database/migrations.mjs'

test('runs ordered migrations once and records the schema version', () => {
  const applied = []
  const migrations = [
    { version: 1, up(db) { applied.push(1); db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY)') } },
    { version: 2, up(db) { applied.push(2); db.exec('ALTER TABLE sample ADD COLUMN name TEXT') } },
  ]
  const first = openMigratedDatabase({ migrations, name: '测试' })
  assert.deepEqual(applied, [1, 2])
  assert.equal(first.version, 2)
  assert.equal(first.db.prepare('PRAGMA user_version').get().user_version, 2)
  first.db.close()
})

test('backs up an existing file before upgrading it', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ppm-migration-backup-'))
  const filename = path.join(root, 'state.sqlite')
  t.after(() => rm(root, { recursive: true, force: true }))
  const legacy = new DatabaseSync(filename)
  legacy.exec('CREATE TABLE legacy (value TEXT); INSERT INTO legacy VALUES (\'kept\');')
  legacy.close()

  const migrated = openMigratedDatabase({
    filename,
    name: '测试',
    migrations: [{ version: 1, up(db) { db.exec('CREATE TABLE added (id INTEGER)') } }],
  })
  assert.ok(migrated.backupFile)
  assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version, 1)
  migrated.db.close()

  const files = await readdir(root)
  const backup = files.find(value => value.startsWith('state.sqlite.backup-v0-'))
  assert.ok(backup)
  const restored = new DatabaseSync(path.join(root, backup))
  assert.equal(restored.prepare('SELECT value FROM legacy').get().value, 'kept')
  assert.equal(restored.prepare("SELECT count(*) count FROM sqlite_master WHERE type='table' AND name='added'").get().count, 0)
  restored.close()
})

test('rolls back a failed migration without advancing the version', () => {
  assert.throws(() => openMigratedDatabase({
    name: '测试',
    migrations: [
      { version: 1, up(db) { db.exec('CREATE TABLE one (id INTEGER)') } },
      { version: 2, up() { throw new Error('boom') } },
    ],
  }), /数据库迁移失败：boom/)
})
