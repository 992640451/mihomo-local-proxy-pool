import { redactSensitive, redactText } from '../security/redaction.mjs'

export function apiError(req, res, {
  status = 500,
  code = 'INTERNAL_ERROR',
  message = '请求处理失败',
  detail,
  error,
  meta,
} = {}) {
  const rawDetail = detail ?? error?.message
  const body = {
    error: {
      code,
      message,
      requestId: req.requestId,
      ...(rawDetail ? { detail: redactText(rawDetail) } : {}),
      ...(meta ? { meta: redactSensitive(meta) } : {}),
    },
  }
  return res.status(status).set('Cache-Control', 'no-store').json(body)
}

export function apiNotFound(req, res) {
  return apiError(req, res, {
    status: 404,
    code: 'API_NOT_FOUND',
    message: '接口不存在',
  })
}

export function apiUnhandledError(error, req, res, _next) {
  if (res.headersSent) return
  console.error(`[${req.requestId}]`, redactText(error?.stack || error?.message || error))
  const clientError = Number(error?.status) >= 400 && Number(error?.status) < 500
  return apiError(req, res, clientError
    ? { status: Number(error.status), code: 'INVALID_REQUEST', message: '请求内容无效', error }
    : { error })
}
