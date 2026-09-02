import assert from 'node:assert/strict'
import test from 'node:test'
import net from 'node:net'
import http from 'node:http'
import { once } from 'node:events'
import { probeProxyEgress, verifyProxyPool } from '../server/egressProbe.mjs'

const body = JSON.stringify({ success: true, ip: '192.0.2.8', country_code: 'US' })
const reply = `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
async function listen(t, server) {
  const sockets = new Set()
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) })
  return server.address().port
}

test('HTTP egress uses the proxy and an independent connection for each sample', async t => {
  let connections = 0
  const proxy = http.createServer((req, res) => {
    assert.equal(req.url, 'http://egress.invalid/')
    res.setHeader('Content-Type', 'application/json')
    res.end(body)
  })
  proxy.on('connection', () => connections++)
  const port = await listen(t, proxy)
  const result = await verifyProxyPool({ host: '127.0.0.1', port, attempts: 2, protocol: 'HTTP', probe: options => probeProxyEgress({ ...options, lookupUrl: 'http://egress.invalid/' }) })
  assert.equal(result.successes, 2)
  assert.equal(connections, 2)
})

test('SOCKS5 egress negotiates SOCKS and sends hostname to the proxy without local DNS', async t => {
  let hostname
  const proxy = net.createServer(socket => {
    let buffer = Buffer.alloc(0), stage = 'greeting'
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      if (stage === 'greeting' && buffer.length >= 2 + buffer[1]) {
        buffer = buffer.subarray(2 + buffer[1]); socket.write(Buffer.from([5, 0])); stage = 'connect'
      }
      if (stage === 'connect' && buffer.length >= 5 && buffer.length >= 7 + buffer[4]) {
        assert.equal(buffer[3], 3)
        hostname = buffer.subarray(5, 5 + buffer[4]).toString()
        buffer = buffer.subarray(7 + buffer[4]); socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80])); stage = 'http'
      }
      if (stage === 'http' && buffer.includes('\r\n\r\n')) { stage = 'done'; socket.end(reply) }
    })
  })
  const port = await listen(t, proxy)
  const result = await probeProxyEgress({ host: '127.0.0.1', port, protocol: 'SOCKS5', lookupUrl: 'http://egress.invalid/', timeoutMs: 1500 })
  assert.equal(result.ip, '192.0.2.8')
  assert.equal(hostname, 'egress.invalid')
})

test('a timeout returns a failure but cancellation rejects without fabricated samples', async t => {
  const proxy = http.createServer()
  proxy.on('connect', (_req, _socket) => {})
  const port = await listen(t, proxy)
  const started = Date.now()
  await assert.rejects(() => probeProxyEgress({ host: '127.0.0.1', port, lookupUrl: 'http://egress.invalid/', timeoutMs: 50 }))
  assert.ok(Date.now() - started < 2000)
  const abort = new AbortController(); abort.abort()
  let called = false
  await assert.rejects(() => verifyProxyPool({ host: '127.0.0.1', port, signal: abort.signal, probe: async () => { called = true } }))
  assert.equal(called, false)
})

test('SOCKS5 handshake stalls honor the configured probe timeout', { timeout: 3000 }, async t => {
  const proxy = net.createServer(socket => socket.on('data', () => {}))
  const port = await listen(t, proxy)
  const started = Date.now()
  await assert.rejects(() => probeProxyEgress({ host: '127.0.0.1', port, protocol: 'SOCKS5', lookupUrl: 'http://egress.invalid/', timeoutMs: 50 }))
  assert.ok(Date.now() - started < 1000)
})
