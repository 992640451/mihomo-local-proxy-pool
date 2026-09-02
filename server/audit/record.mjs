import { redactText } from '../security/redaction.mjs'

export function auditActor(req) {
  return req.auth?.username || 'local-admin'
}

export function recordAudit(auditStore, req, event) {
  if (!auditStore) return null
  try {
    return auditStore.record({ actor: auditActor(req), requestId: req.requestId, ...event })
  } catch (error) {
    console.error(`[${req.requestId}] audit write failed: ${redactText(error.message)}`)
    return null
  }
}
