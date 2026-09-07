// Run explicitly: node tests/proxySessionCore.integration.mjs <mihomo executable>
// All listeners, nodes and data are isolated; no deployed configuration or Internet access.
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import dgram from 'node:dgram'
import { once } from 'node:events'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { ProxyAgent, Socks5ProxyAgent, fetch as proxyFetch } from 'undici'
import { ProxySessionStore } from '../server/proxySessionStore.mjs'
import { ensureEmbeddedCore, applyEmbeddedPort, startEmbeddedProxySession, endEmbeddedProxySession, syncEmbeddedCore } from '../server/embeddedCore.mjs'

const executable = process.argv[2]
if (!executable) throw new Error('Provide an installed Mihomo executable (the project pins v1.19.28)')
const directory = await mkdtemp(path.join(os.tmpdir(), 'ppm-session-core-'))
const servers = [], sockets = new Set()
const datagrams = []
let core, log = '', store
async function listen(server) { servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port }
async function freePort() { const server = net.createServer(); const port = await listen(server); await new Promise(resolve => server.close(resolve)); servers.pop(); return port }
const definitions = []
try {
  for (const id of ['a', 'b', 'c']) {
    const server = http.createServer((_req, res) => { res.setHeader('Connection', 'close'); setTimeout(() => res.end(id), 15) })
    server.on('connect', (_req, socket, head) => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) socket.unshift(head); server.emit('connection', socket) })
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
    definitions.push({ id, active: true, raw: { name: id, type: 'http', server: '127.0.0.1', port: await listen(server) } })
  }
  for (const id of ['ua', 'ub']) {
    const udp = dgram.createSocket('udp4'); datagrams.push(udp)
    udp.bind(0, '127.0.0.1'); await once(udp, 'listening')
    udp.on('message', (packet, remote) => udp.send(Buffer.concat([packet.subarray(0, 10), Buffer.from(id)]), remote.port, remote.address))
    const server = net.createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket))
      let greeting = true
      socket.on('data', data => {
        if (greeting) { greeting = false; socket.write(Buffer.from([5,0])); return }
        const relay = udp.address().port
        // The fixture only implements UDP ASSOCIATE. Delay checks use the separate HTTP nodes.
        if (data[1] === 3) socket.write(Buffer.from([5,0,0,1,127,0,0,1,relay >> 8,relay & 255]))
        else socket.destroy()
      })
    })
    definitions.push({ id, active: true, raw: { name: id, type: 'socks5', server: '127.0.0.1', port: await listen(server), udp: true } })
  }
  const controllerPort = await freePort(), port = await freePort(), otherPort = await freePort()
  store = new ProxySessionStore({ filename: path.join(directory, 'sessions.sqlite') })
  const options = { statePath: path.join(directory, 'state.json'), configPath: path.join(directory, 'config.yaml'),
    controllerConfigPath: path.join(directory, 'config.yaml'), controllerUrl: `http://127.0.0.1:${controllerPort}`, controllerAddress: `127.0.0.1:${controllerPort}`,
    controllerSecret: '', listenerHost: '127.0.0.1', portRanges: '', definitionProvider: async () => definitions, proxySessionStore: store }
  await ensureEmbeddedCore('', options)
  const request = async pathname => (await fetch(`${options.controllerUrl}${pathname}`, { signal: AbortSignal.timeout(3000) })).json()
  const startCore = async () => {
    core = spawn(path.resolve(executable), ['-d', directory, '-f', options.configPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    core.stdout.on('data', data => { log += data }); core.stderr.on('data', data => { log += data })
    for (let retry = 0; retry < 100; retry++) { try { await request('/version'); return } catch { await sleep(100) } }
    throw new Error(`Core did not start: ${log.slice(-2000)}`)
  }
  await startCore()
  await applyEmbeddedPort({ source: '', ...options, port, nodeIds: ['a', 'b', 'c'], protocol: 'Mixed', strategy: 'session-round-robin', strategyOptions: { healthCheckUrl: 'http://127.0.0.1:12345/check', timeoutMs: 1000 } })
  await applyEmbeddedPort({ source: '', ...options, port: otherPort, nodeIds: ['c'], protocol: 'Mixed', strategy: 'select' })
  const probe = async (protocol, proxyPort = port, target = 12345) => {
    const dispatcher = protocol === 'socks' ? new Socks5ProxyAgent(`socks5://127.0.0.1:${proxyPort}`) : new ProxyAgent(`http://127.0.0.1:${proxyPort}`)
    try { return await (await proxyFetch(`http://127.0.0.1:${target}/identity`, { dispatcher, signal: AbortSignal.timeout(4000) })).text() }
    finally { await dispatcher.destroy() }
  }
  assert.equal(['a','b','c'].includes(await probe('http').catch(() => null)), false)
  const tunnel = async targetPort => {
    const socket = net.connect(targetPort, '127.0.0.1'); await once(socket, 'connect')
    socket.write('CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n')
    const [data] = await once(socket, 'data'); assert.match(data.toString(), /200/)
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket
  }
  let previousId
  for (const [index, expected] of ['a', 'b', 'c', 'a'].entries()) {
    const session = await startEmbeddedProxySession('', port, { launchId: `real-core-${index}` }, options)
    assert.equal(session.session.nodeId, expected)
    const values = await Promise.all(Array.from({ length: 12 }, (_, i) => probe(i % 2 ? 'socks' : 'http', port, 12345 + i)))
    assert.deepEqual(new Set(values), new Set([expected]))
    if (previousId) await endEmbeddedProxySession('', port, previousId, options)
    await syncEmbeddedCore('', options)
    assert.equal(await probe('socks'), expected)
    if (index === 0) {
      // Real process restart reads the durable singleton binding without a selection API call.
      core.kill(); await once(core, 'exit'); await startCore()
      assert.equal(await probe('http'), expected)
    }
    const own = await tunnel(port), other = await tunnel(otherPort)
    await sleep(100)
    await endEmbeddedProxySession('', port, session.session.sessionId, options)
    const active = (await request('/connections')).connections
    assert.equal(active.some(connection => connection.chains.includes(`PPM-${port}`)), false)
    assert.equal(active.some(connection => connection.chains.includes(`PPM-${otherPort}`)), true)
    own.destroy(); other.destroy()
    assert.equal(await probe('http', otherPort), 'c')
    assert.equal(['a','b','c'].includes(await probe('socks').catch(() => null)), false)
    previousId = session.session.sessionId
  }
  // Seed two already-selected UDP sessions to exercise binding/config/cleanup with real datagrams.
  const udpPort = await freePort()
  await applyEmbeddedPort({ source: '', ...options, port: udpPort, nodeIds: ['ua','ub'], protocol: 'SOCKS5', strategy: 'session-round-robin' })
  const { nodeFingerprint } = await import('../server/proxySessionStore.mjs')
  for (const id of ['ua','ub']) {
    const record = store.create(udpPort, `udp-session-${id}`, 'udp-test'), definition = definitions.find(node => node.id === id)
    store.save({ ...record, nodeId: id, nodeName: id, nodeFingerprint: nodeFingerprint(definition.raw), state: 'active', startedAt: Date.now() })
    await syncEmbeddedCore('', options)
    const control = net.connect(udpPort, '127.0.0.1'); sockets.add(control); await once(control, 'connect')
    control.write(Buffer.from([5,1,0])); await once(control, 'data')
    control.write(Buffer.from([5,3,0,1,0,0,0,0,0,0])); const [reply] = await once(control, 'data')
    assert.equal(reply[1], 0)
    const udp = dgram.createSocket('udp4'); datagrams.push(udp); udp.bind(0, '127.0.0.1'); await once(udp, 'listening')
    for (let target = 12345; target < 12348; target++) {
      const packet = Buffer.from([0,0,0,1,127,0,0,1,target >> 8,target & 255,42])
      udp.send(packet, udpPort, '127.0.0.1')
      const [received] = await once(udp, 'message', { signal: AbortSignal.timeout(4000) })
      assert.equal(received.subarray(10).toString(), id)
    }
    await endEmbeddedProxySession('', udpPort, record.sessionId, options)
    assert.equal(((await request('/connections')).connections || []).some(connection => connection.chains.includes(`PPM-${udpPort}`)), false)
    control.destroy()
  }
  console.log(JSON.stringify({ ok: true, core: await request('/version'), sequence: ['a','b','c','a'], concurrentRequests: 48, udpDatagrams: 6, protocols: ['HTTP CONNECT', 'SOCKS5', 'SOCKS5 UDP'], restart: true, isolatedConnectionCleanup: true, directory }))
} catch (error) { console.error(log.slice(-3000)); throw error }
finally {
  if (core?.exitCode === null) { core.kill(); await once(core, 'exit') }
  for (const socket of sockets) socket.destroy()
  for (const socket of datagrams) socket.close()
  for (const server of servers) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)) }
  store?.close()
}
