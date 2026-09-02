import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { encryptRecoveryPayload, decryptRecoveryPayload } from '../server/recovery/crypto.mjs'
import { RecoveryService } from '../server/recovery/service.mjs'
import { SubscriptionStore } from '../server/subscriptions/store.mjs'
import { parseSubscription } from '../server/subscriptions/parser.mjs'
import { RECOVERY_MAX_FILE_BYTES, RECOVERY_MAX_PAYLOAD_BYTES, RECOVERY_MAX_REQUEST_BYTES } from '../shared/recoveryLimits.js'

const yaml = `proxies:\n  - name: Japan A\n    type: ss\n    server: jp.example.com\n    port: 443\n    cipher: aes-128-gcm\n    password: secret\n`

function recoverySubscription(id = 'subscription-1') {
  const parsed = parseSubscription(yaml, { subscriptionId: id })
  return {
    id, name: 'Primary', sourceType: 'url', url: 'https://example.com/sub/token', enabled: true,
    priority: 10, refreshIntervalSeconds: 3600, etag: null, lastModified: null,
    lastAttemptAt: Date.now(), lastSuccessAt: Date.now(), lastError: null, createdAt: Date.now(), updatedAt: Date.now(),
    snapshot: { id: 'snapshot-1', content: yaml, contentHash: createHash('sha256').update(yaml).digest('hex'), format: parsed.format, nodeCount: 1, createdAt: Date.now() },
    nodes: parsed.nodes.map(node => ({ ...node, active: true, orphanedAt: null, createdAt: Date.now(), updatedAt: Date.now() })),
  }
}

test('encrypts recovery payloads and rejects wrong passwords or tampering', async () => {
  const payload = { format: 'ppm-recovery-data', version: 1, data: { value: 'secret' } }
  const recoveryPackage = await encryptRecoveryPayload(payload, 'correct horse battery staple', { salt: Buffer.alloc(16, 1), iv: Buffer.alloc(12, 2) })
  assert.deepEqual(await decryptRecoveryPayload(recoveryPackage, 'correct horse battery staple'), payload)
  await assert.rejects(() => decryptRecoveryPayload(recoveryPackage, 'wrong password'), /口令错误|已损坏/)
  const tampered = structuredClone(recoveryPackage)
  tampered.cipher.data = `${tampered.cipher.data.slice(0, -4)}AAAA`
  await assert.rejects(() => decryptRecoveryPayload(tampered, 'correct horse battery staple'), /口令错误|已损坏/)
})

test('round-trips payloads at the UTF-8 size boundary within file and request limits', async () => {
  for (const size of [RECOVERY_MAX_PAYLOAD_BYTES - 1, RECOVERY_MAX_PAYLOAD_BYTES]) {
    const contentBytes = size - Buffer.byteLength(JSON.stringify({ text: '' }))
    const payload = { text: '界'.repeat(Math.floor(contentBytes / 3)) + 'x'.repeat(contentBytes % 3) }
    assert.equal(Buffer.byteLength(JSON.stringify(payload)), size)
    const recoveryPackage = await encryptRecoveryPayload(payload, 'boundary password')
    // The download route also adds a small, unencrypted summary.
    recoveryPackage.summary = { subscriptions: 1000, nodes: 100000, ports: 65535 }
    assert.ok(Buffer.byteLength(JSON.stringify(recoveryPackage)) <= RECOVERY_MAX_FILE_BYTES)
    assert.ok(Buffer.byteLength(JSON.stringify({ recoveryPackage, password: '\u0000'.repeat(256) })) <= RECOVERY_MAX_REQUEST_BYTES)
    assert.deepEqual(await decryptRecoveryPayload(recoveryPackage, 'boundary password'), payload)
  }
})

test('rejects oversized payloads before key derivation and rejects oversized imports', async () => {
  const contentBytes = RECOVERY_MAX_PAYLOAD_BYTES + 1 - Buffer.byteLength(JSON.stringify({ text: '' }))
  const payload = { text: '界'.repeat(Math.floor(contentBytes / 3)) + 'x'.repeat(contentBytes % 3) }
  assert.equal(Buffer.byteLength(JSON.stringify(payload)), RECOVERY_MAX_PAYLOAD_BYTES + 1)
  // An invalid password would fail first if key derivation had already started.
  await assert.rejects(() => encryptRecoveryPayload(payload, ''), /原始数据超过 24 MiB/)
  const recoveryPackage = await encryptRecoveryPayload({ ok: true }, 'boundary password')
  recoveryPackage.cipher.data = Buffer.alloc(RECOVERY_MAX_PAYLOAD_BYTES + 1).toString('base64')
  await assert.rejects(() => decryptRecoveryPayload(recoveryPackage, ''), /data 无效/)
  recoveryPackage.extra = 'x'.repeat(1024 * 1024)
  await assert.rejects(() => decryptRecoveryPayload(recoveryPackage, ''), /文件超过 33 MiB/)
})

test('exports and replaces complete subscription recovery state without changing node ids', () => {
  const store = new SubscriptionStore({ masterKey: 'master-key-at-least-16-characters' })
  const original = recoverySubscription()
  store.replaceRecovery([original])
  const exported = store.exportRecovery()
  assert.equal(exported[0].url, original.url)
  assert.equal(exported[0].nodes[0].id, original.nodes[0].id)
  store.replaceRecovery([])
  assert.equal(store.list().length, 0)
  store.replaceRecovery(exported)
  assert.equal(store.list()[0].nodeCount, 1)
  assert.equal(store.definitions()[0].id, original.nodes[0].id)
  store.close()
})

test('rolls back subscription and port state when port restoration fails', async () => {
  let subscriptions = [recoverySubscription('old-subscription')]
  let ports = { version: 2, ports: { 17900: { nodeId: subscriptions[0].nodes[0].id } } }
  const store = {
    exportRecovery: () => structuredClone(subscriptions),
    replaceRecovery: value => { subscriptions = structuredClone(value) },
  }
  let calls = 0
  const service = new RecoveryService({
    subscriptionStore: store,
    appVersion: '1.0.0',
    exportPorts: async () => structuredClone(ports),
    restorePorts: async value => {
      calls += 1
      if (calls === 1) throw new Error('reload failed')
      ports = structuredClone(value)
      return { ports: Object.keys(value.ports).length }
    },
  })
  const payload = {
    format: 'ppm-recovery-data', version: 1, appVersion: '1.0.0', createdAt: Date.now(),
    data: { subscriptions: [recoverySubscription('new-subscription')], ports: { version: 2, ports: {} } },
  }
  const recoveryPackage = await encryptRecoveryPayload(payload, 'restore password')
  await assert.rejects(() => service.restore(recoveryPackage, 'restore password'), /原配置已恢复/)
  assert.equal(subscriptions[0].id, 'old-subscription')
  assert.equal(Object.keys(ports.ports).length, 1)
})
