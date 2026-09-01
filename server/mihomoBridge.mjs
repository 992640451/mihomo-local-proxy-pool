import http from 'node:http'
import net from 'node:net'

const host = process.env.MIHOMO_BRIDGE_HOST || '0.0.0.0'
const port = Number(process.env.MIHOMO_BRIDGE_PORT || 9098)
const secret = process.env.MIHOMO_CONTROLLER_SECRET || ''
const configPath = process.env.MIHOMO_HOST_CONFIG_PATH || ''
const pipePath = process.env.MIHOMO_CONTROLLER_PIPE || '\\\\.\\pipe\\verge-mihomo'

if (!secret || secret.length < 32) throw new Error('MIHOMO_CONTROLLER_SECRET 至少需要 32 个字符')
if (!configPath) throw new Error('MIHOMO_HOST_CONFIG_PATH 未配置')

function sendPipeRequest(method, requestPath, body = '') {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath)
    let response = '', settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      socket.destroy()
      error ? reject(error) : resolve(value)
    }
    socket.setEncoding('utf8')
    socket.setTimeout(5000)
    socket.once('connect', () => socket.write([
      `${method} ${requestPath} HTTP/1.1`,
      'Host: localhost',
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close', '', body,
    ].join('\r\n')))
    socket.on('data', chunk => { response += chunk })
    socket.once('end', () => {
      const status = Number(response.match(/^HTTP\/1\.1\s+(\d+)/)?.[1] || 0)
      const payload = response.slice(response.indexOf('\r\n\r\n') + 4)
      if (status < 200 || status >= 300) return finish(new Error(`Mihomo pipe HTTP ${status}: ${payload}`))
      finish(null, { status, payload })
    })
    socket.once('timeout', () => finish(new Error('Mihomo pipe timeout')))
    socket.once('error', error => finish(error))
  })
}

export function createBridgeServer() {
  return http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    if (req.headers.authorization !== `Bearer ${secret}`) {
      res.writeHead(401).end(JSON.stringify({ error: 'unauthorized' })); return
    }
    if (req.method === 'GET' && req.url === '/healthz') {
      try {
        const result = await sendPipeRequest('GET', '/version')
        res.writeHead(200).end(result.payload)
      } catch (error) { res.writeHead(503).end(JSON.stringify({ error: error.message })) }
      return
    }
    if (req.method === 'PUT' && req.url?.startsWith('/configs')) {
      try {
        await sendPipeRequest('PUT', '/configs?force=true', JSON.stringify({ path: configPath }))
        res.writeHead(204).end()
      } catch (error) { res.writeHead(502).end(JSON.stringify({ error: error.message })) }
      return
    }
    res.writeHead(404).end(JSON.stringify({ error: 'not_found' }))
  })
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  createBridgeServer().listen(port, host, () => console.log(`Mihomo bridge listening at http://${host}:${port}`))
}
