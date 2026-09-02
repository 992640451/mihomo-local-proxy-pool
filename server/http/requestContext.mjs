import { randomUUID } from 'node:crypto'

const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export function requestContext(req, res, next) {
  const supplied = String(req.get('X-Request-Id') || '')
  req.requestId = SAFE_REQUEST_ID.test(supplied) ? supplied : randomUUID()
  res.set('X-Request-Id', req.requestId)
  next()
}
