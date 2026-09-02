import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { recordAudit } from '../audit/record.mjs'
import { apiError } from '../http/responses.mjs'

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const separator = part.indexOf('=')
    if (separator < 0) return [part, '']
    try { return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))] }
    catch { return [part.slice(0, separator), ''] }
  }))
}

export function registerAuthRoutes(app, {
  configured,
  username: configuredUsername,
  passwordSalt,
  passwordHash,
  sessionStore,
  sessionIdleMs,
  sessionAbsoluteMs,
  rememberedSessionIdleMs,
  rememberedSessionAbsoluteMs,
  cookieName = 'ppm_session',
  cookieSecure = false,
  auditStore,
  tokenStore,
} = {}) {
  const attempts = new Map()

  function pruneAttempts(now) {
    for (const [key, value] of attempts) {
      if (now - value.since > 15 * 60 * 1000) attempts.delete(key)
    }
    while (attempts.size > 1024) attempts.delete(attempts.keys().next().value)
  }

  function cookieHeader(req, value, maxAgeSeconds) {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase()
    const secure = cookieSecure || req.secure || forwardedProto === 'https'
    return [`${cookieName}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', Number.isFinite(maxAgeSeconds) ? `Max-Age=${maxAgeSeconds}` : '', secure ? 'Secure' : ''].filter(Boolean).join('; ')
  }

  function findSession(req, touch = false) {
    const id = parseCookies(req)[cookieName]
    const session = sessionStore.find(id, { touch })
    if (!id || !session) return null
    return { id, session }
  }

  function requireAuth(req, res, next) {
    const versioned = /^\/api\/v1(?:\/|\?|$)/i.test(req.originalUrl)
    if (req.headers.authorization !== undefined) {
      const match = /^Bearer (\S+)$/i.exec(req.headers.authorization)
      const token = configured && versioned && match ? tokenStore?.authenticate(match[1]) : null
      if (!token) return apiError(req, res, { status: 401, code: 'INVALID_API_TOKEN', message: 'API 令牌无效、已过期、已撤销或接口不支持令牌认证' })
      req.auth = { type: 'token', username: `api/${token.id}`, tokenId: token.id, scopes: token.scopes }
      return next()
    }
    if (!configured) {
      if (versioned) return apiError(req, res, { status: 503, code: 'AUTH_NOT_CONFIGURED', message: '自动化 API 需要先配置管理认证' })
      req.auth = { type: 'local', username: 'local-admin' }; return next()
    }
    const found = findSession(req, true)
    if (found) { req.auth = { type: 'session', username: found.session.username }; return next() }
    res.set('Set-Cookie', cookieHeader(req, '', 0))
    return apiError(req, res, { status: 401, code: 'AUTH_REQUIRED', message: '需要登录' })
  }

  app.post('/api/auth/login', (req, res) => {
    if (!configured) return apiError(req, res, { status: 503, code: 'AUTH_NOT_CONFIGURED', message: '管理认证尚未配置' })
    const key = req.ip, now = Date.now(), started = Date.now()
    pruneAttempts(now)
    const record = attempts.get(key) || { count: 0, since: now }
    if (now - record.since > 15 * 60 * 1000) { record.count = 0; record.since = now }
    if (record.count >= 8) {
      recordAudit(auditStore, req, { actor: 'anonymous', action: 'auth.login', outcome: 'failure', targetType: 'session', message: '登录请求被频率限制', durationMs: Date.now() - started })
      res.set('Retry-After', '900')
      return apiError(req, res, { status: 429, code: 'TOO_MANY_ATTEMPTS', message: '登录尝试次数过多', meta: { retryAfterSeconds: 900 } })
    }
    const username = String(req.body?.username || ''), password = String(req.body?.password || ''), remember = req.body?.remember === true
    const candidate = scryptSync(password, passwordSalt, 64), expected = Buffer.from(passwordHash, 'hex')
    const valid = username === configuredUsername && candidate.length === expected.length && timingSafeEqual(candidate, expected)
    if (!valid) {
      record.count += 1
      attempts.set(key, record)
      recordAudit(auditStore, req, { actor: 'anonymous', action: 'auth.login', outcome: 'failure', targetType: 'session', message: '管理页面登录失败', durationMs: Date.now() - started })
      return apiError(req, res, { status: 401, code: 'INVALID_CREDENTIALS', message: '账号或密码不正确', meta: { remainingAttempts: Math.max(0, 8 - record.count) } })
    }
    attempts.delete(key)
    sessionStore.prune()
    const id = randomBytes(32).toString('base64url')
    const idleMs = remember ? rememberedSessionIdleMs : sessionIdleMs
    const absoluteMs = remember ? rememberedSessionAbsoluteMs : sessionAbsoluteMs
    sessionStore.create(id, username, now, { idleMs, absoluteMs })
    req.auth = { username }
    recordAudit(auditStore, req, { action: 'auth.login', targetType: 'session', message: '管理页面登录成功', durationMs: Date.now() - started, metadata: { remembered: remember } })
    res.set('Cache-Control', 'no-store').set('Set-Cookie', cookieHeader(req, id, remember ? Math.floor(absoluteMs / 1000) : undefined)).json({ authenticated: true, remembered: remember, expiresIn: Math.floor(Math.min(idleMs, absoluteMs) / 1000) })
  })

  app.get('/api/auth/session', (req, res) => {
    if (!configured) return res.json({ authenticated: true, expiresIn: null })
    const found = findSession(req, true)
    if (!found) {
      res.set('Set-Cookie', cookieHeader(req, '', 0))
      return apiError(req, res, { status: 401, code: 'AUTH_REQUIRED', message: '登录状态已失效' })
    }
    const remaining = Math.max(0, Math.min(found.session.idleTimeoutMs, found.session.absoluteExpiresAt - Date.now()))
    res.set('Cache-Control', 'no-store').json({ authenticated: true, remembered: found.session.idleTimeoutMs > sessionIdleMs, expiresIn: Math.floor(remaining / 1000) })
  })

  app.post('/api/auth/logout', (req, res) => {
    const id = parseCookies(req)[cookieName]
    const found = sessionStore.find(id)
    if (found) req.auth = { username: found.username }
    sessionStore.delete(id)
    recordAudit(auditStore, req, { action: 'auth.logout', targetType: 'session', message: '已退出管理页面' })
    res.status(204).set('Cache-Control', 'no-store').set('Set-Cookie', cookieHeader(req, '', 0)).end()
  })

  return { requireAuth }
}
