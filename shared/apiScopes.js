export const API_SCOPES = {
  read: '只读（状态、订阅目录、诊断）',
  'subscriptions:write': '订阅管理（导入、刷新、修改、删除）',
  'ports:write': '端口管理（配置、删除、主动验证）',
}

export function normalizeApiScopes(value) {
  if (!Array.isArray(value) || !value.length || value.some(scope => !Object.hasOwn(API_SCOPES, scope))) throw new Error('请选择有效的 API 权限')
  // Management scopes include the non-secret read surface.
  return [...new Set(['read', ...value])].sort()
}
