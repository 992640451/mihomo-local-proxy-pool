import { apiError } from '../http/responses.mjs'

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function securityHeaders(_req, res, next) {
  res.set({
    'Content-Security-Policy': "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'",
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  })
  next()
}

export function createOriginGuard({ allowedOrigins = [], trustProxy = false } = {}) {
  const configured = new Set((Array.isArray(allowedOrigins) ? allowedOrigins : String(allowedOrigins).split(','))
    .map(value => String(value).trim().replace(/\/$/, '')).filter(Boolean))
  return function originGuard(req, res, next) {
    if (!MUTATING_METHODS.has(req.method)) return next()
    const fetchSite = String(req.get('Sec-Fetch-Site') || '').toLowerCase()
    const supplied = String(req.get('Origin') || '').trim().replace(/\/$/, '')
    if (!supplied) {
      if (fetchSite === 'cross-site') return apiError(req, res, { status: 403, code: 'CROSS_ORIGIN_REQUEST', message: '拒绝跨站请求' })
      return next()
    }
    let origin
    try { origin = new URL(supplied) } catch { return apiError(req, res, { status: 403, code: 'INVALID_ORIGIN', message: '请求来源无效' }) }
    const hosts = new Set([String(req.get('Host') || '').toLowerCase()])
    if (trustProxy) hosts.add(String(req.get('X-Forwarded-Host') || '').split(',')[0].trim().toLowerCase())
    const sameHost = ['http:', 'https:'].includes(origin.protocol) && hosts.has(origin.host.toLowerCase())
    if (sameHost || configured.has(origin.origin)) return next()
    return apiError(req, res, { status: 403, code: 'CROSS_ORIGIN_REQUEST', message: '拒绝跨站请求' })
  }
}
