import { API_OPERATIONS } from './contract.mjs'
import { apiError } from '../http/responses.mjs'
import { recordAudit } from '../audit/record.mjs'
import { validateRequest } from './validation.mjs'

export function requireScopes(scopes, auditStore) {
  return (req, res, next) => {
    res.set('Cache-Control', 'no-store')
    if (req.auth?.type === 'session') return next()
    if (req.auth?.type === 'token' && scopes.every(scope => req.auth.scopes.includes(scope))) return next()
    recordAudit(auditStore, req, { action: 'api.accessDenied', outcome: 'failure', message: 'API 权限不足', metadata: { requiredScopes: scopes } })
    return apiError(req, res, { status: 403, code: 'INSUFFICIENT_SCOPE', message: 'API 令牌权限不足', meta: { requiredScopes: scopes } })
  }
}

// Register existing UI handlers AND only their explicitly frozen v1 aliases.
export function versionedRegistrar(app, { auditStore } = {}) {
  return Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method => [method, (path, ...handlers) => {
    app[method](path, ...handlers)
    const operation = API_OPERATIONS.find(item => item.method === method && `/api${item.path}` === path)
    if (operation) app[method](`/api/v1${operation.path}`, requireScopes(operation.scopes, auditStore), validateRequest(operation), ...handlers)
  }]))
}
