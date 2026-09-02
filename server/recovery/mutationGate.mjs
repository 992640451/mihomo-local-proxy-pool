import { apiError } from '../http/responses.mjs'

export function createMutationGate() {
  let activeMutations = 0, restoring = false
  const wrap = (handler, restoreRequest) => async (req, res, next) => {
    if (restoreRequest) {
      if (restoring || activeMutations > 0) return apiError(req, res, { status: 409, code: 'CONFIGURATION_BUSY', message: '当前有配置操作正在执行，请稍后重试恢复' })
      restoring = true
    } else {
      if (restoring) return apiError(req, res, { status: 409, code: 'RECOVERY_IN_PROGRESS', message: '配置恢复正在执行，请稍后重试' })
      activeMutations += 1
    }
    // Hold the lease until business work settles, even if the client disconnects.
    try {
      return await handler(req, res, next)
    } finally {
      if (restoreRequest) restoring = false
      else activeMutations -= 1
    }
  }
  // Declare the operation on its handler, not on a separately parsed URL.
  return { mutation: handler => wrap(handler, false), restore: handler => wrap(handler, true) }
}
