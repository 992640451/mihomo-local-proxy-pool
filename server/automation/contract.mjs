// This allowlist is shared by the router and OpenAPI; new UI routes are NOT
// automatically exposed to automation credentials.
export const API_OPERATIONS = [
  ['get', '/openapi.json', 'getOpenApi', '读取 API 合同', ['read'], null, 'OpenApi'],
  ['get', '/runtime', 'getRuntime', '读取运行状态', ['read'], null, 'Runtime'],
  ['get', '/diagnostics', 'runDiagnostics', '运行脱敏系统诊断', ['read'], null, 'Diagnostics'],
  ['get', '/subscriptions/catalog', 'getCatalog', '读取不含节点凭据的目录', ['read'], null, 'Catalog'],
  ['get', '/subscriptions', 'listSubscriptions', '列出订阅（URL 脱敏）', ['read'], null, 'Subscriptions'],
  ['post', '/subscriptions', 'createSubscription', '导入订阅', ['subscriptions:write'], 'SubscriptionCreate', 'Subscription', 201],
  ['patch', '/subscriptions/:id', 'updateSubscription', '更新订阅', ['subscriptions:write'], 'SubscriptionPatch', 'Subscription'],
  ['delete', '/subscriptions/:id', 'deleteSubscription', '删除未被端口引用的订阅', ['subscriptions:write'], null, null, 204],
  ['post', '/subscriptions/:id/refresh', 'refreshSubscription', '刷新一个远程订阅', ['subscriptions:write'], null, 'Subscription'],
  ['post', '/subscriptions/refresh-all', 'refreshSubscriptions', '刷新所有启用的远程订阅（逐项返回结果）', ['subscriptions:write'], null, 'RefreshResults'],
  ['get', '/ports', 'listPorts', '列出端口配置', ['read'], null, 'Ports'],
  ['put', '/ports/:port', 'applyPort', '创建或替换端口配置', ['ports:write'], 'PortInput', 'PortResult'],
  ['delete', '/ports/:port', 'deletePort', '删除端口配置（幂等）', ['ports:write'], null, 'PortDeletion'],
  ['get', '/ports/:port/status', 'getPortStatus', '读取策略组状态', ['read'], null, 'PortStatus'],
  ['post', '/ports/:port/verify', 'verifyPort', '主动验证代理池；会产生网络流量', ['ports:write'], 'VerifyInput', 'Verification'],
  ['post', '/config/export', 'exportConfiguration', '导出加密配置（包含凭据，须有全部管理权限）', ['subscriptions:write', 'ports:write'], 'ExportInput', 'RecoveryPackage'],
  ['post', '/config/plan', 'planConfiguration', '只预检：比较增改删和缺失节点，不应用配置', ['subscriptions:write', 'ports:write'], 'PlanInput', 'ConfigurationPlan'],
  ['post', '/config/apply', 'applyConfiguration', '应用未过期且基线未变的预检计划', ['subscriptions:write', 'ports:write'], 'ApplyInput', 'RecoveryResult'],
].map(([method, path, operationId, summary, scopes, input, output, status = 200]) => ({ method, path, operationId, summary, scopes, input, output, status }))

const string = { type: 'string' }, integer = { type: 'integer' }, boolean = { type: 'boolean' }
const nullableString = { type: ['string', 'null'] }, timestamp = { type: ['integer', 'null'], description: 'Unix milliseconds' }
const ref = name => ({ $ref: `#/components/schemas/${name}` })
const array = items => ({ type: 'array', items })
const object = (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) })
const subscriptionProperties = {
  name: string, url: string, content: string, enabled: boolean,
  priority: { type: 'integer', minimum: -10000, maximum: 10000 },
  refreshIntervalSeconds: { type: 'integer', minimum: 60, maximum: 604800 },
}
const portProperties = {
  nodeId: string, nodeIds: { ...array(string), minItems: 1, maxItems: 64, uniqueItems: true },
  strategy: { enum: ['select', 'fallback', 'url-test', 'consistent-hashing', 'round-robin'] },
  protocol: { enum: ['Mixed', 'HTTP', 'SOCKS5'] }, enabled: boolean,
  strategyOptions: object({ healthCheckUrl: { type: 'string', format: 'uri' }, intervalSeconds: integer, timeoutMs: integer, toleranceMs: integer, maxFailedTimes: integer }),
}
const delta = object({ added: array(string), modified: array(string), deleted: array(string), unchanged: integer }, ['added', 'modified', 'deleted', 'unchanged'])
const summary = { appVersion: string, createdAt: timestamp, subscriptions: integer, nodes: integer, ports: integer }
const importProperties = { recoveryPackage: ref('RecoveryPackage'), password: { type: 'string', minLength: 8, maxLength: 256, writeOnly: true } }

export const API_SCHEMAS = {
  Error: object({ error: object({ code: string, message: string, requestId: string, detail: string, meta: { type: 'object' } }, ['code', 'message', 'requestId']) }, ['error']),
  OpenApi: object({ openapi: string, info: { type: 'object' }, paths: { type: 'object' } }, ['openapi', 'info', 'paths']),
  Runtime: object({ appVersion: string, startedAt: timestamp, processUptimeSeconds: integer, systemUptimeSeconds: integer, totalNodes: integer, providerCount: integer, countryCount: integer, hostname: string, platform: string, core: { type: 'object' }, buildInfo: { type: ['object', 'null'] } }, ['appVersion', 'totalNodes', 'core']),
  Diagnostics: object({ status: { enum: ['ok', 'warning', 'error'] }, checkedAt: timestamp, errors: integer, warnings: integer, checks: array(object({ name: string, status: string, durationMs: integer, message: string, details: { type: 'object' } }, ['name', 'status', 'durationMs'])) }, ['status', 'checks']),
  Catalog: object({ source: string, updatedAt: string, providers: array(object({ id: string, name: string, nodeCount: integer }, ['id', 'name'])), countries: array({ type: 'object' }), nodes: array(object({ id: string, name: string, providerId: string, country: string, code: string, healthy: { type: ['boolean', 'null'] }, delay: { type: ['number', 'null'] } }, ['id', 'name'])), listeners: array(ref('Port')) }, ['nodes', 'providers', 'listeners']),
  SubscriptionCreate: { ...object(subscriptionProperties, ['name']), anyOf: [{ required: ['url'] }, { required: ['content'] }] },
  SubscriptionPatch: object(subscriptionProperties),
  Subscription: object({ id: string, name: string, sourceType: { enum: ['url', 'inline', 'legacy'] }, url: nullableString, enabled: boolean, priority: integer, refreshIntervalSeconds: integer, nodeCount: integer, lastError: nullableString, lastAttemptAt: timestamp, lastSuccessAt: timestamp, createdAt: timestamp, updatedAt: timestamp }, ['id', 'name', 'nodeCount', 'enabled']),
  Subscriptions: object({ mode: string, subscriptions: array(ref('Subscription')) }, ['mode', 'subscriptions']),
  RefreshResults: object({ results: array(object({ id: string, ok: boolean, error: string, subscription: ref('Subscription') }, ['id', 'ok'])) }, ['results']),
  PortInput: { ...object(portProperties), anyOf: [{ required: ['nodeId'] }, { required: ['nodeIds'] }] },
  // Global listeners route dynamically and may have no fixed nodes; writes still require a nonempty pool.
  Port: object({ ...portProperties, nodeIds: { ...portProperties.nodeIds, minItems: 0 }, protocol: { enum: ['Mixed', 'MIXED', 'HTTP', 'SOCKS5'] }, port: integer, id: string, isGlobal: boolean, listen: string, managedBy: string, lastChecked: string }, ['port', 'nodeIds', 'protocol', 'enabled']),
  Ports: object({ ports: array(ref('Port')) }, ['ports']),
  PortResult: object({ ...portProperties, port: integer, reloaded: boolean, reloadRequired: boolean }, ['port']),
  PortDeletion: object({ port: integer, removed: boolean, reloaded: boolean, reloadRequired: boolean }, ['port', 'removed']),
  PortStatus: object({ port: integer, strategy: string, activeNodeId: nullableString, activeNodeName: nullableString, reachable: boolean,
    nodes: array(object({ nodeId: string, nodeName: string, healthy: { type: ['boolean', 'null'] }, history: array(object({ time: string, delay: { type: 'number' } })) }, ['nodeId', 'nodeName', 'healthy', 'history'])),
  }, ['port', 'strategy', 'activeNodeId', 'activeNodeName', 'reachable', 'nodes']),
  VerifyInput: object({ attempts: { type: 'integer', minimum: 2, maximum: 8, default: 8 } }),
  Verification: object({ attempts: integer, successes: integer, failures: integer, uniqueExitCount: integer, results: array({ type: 'object' }), distribution: array({ type: 'object' }) }, ['attempts', 'successes', 'failures']),
  ExportInput: object({ password: importProperties.password }, ['password']),
  RecoveryPackage: object({ format: { const: 'ppm-recovery' }, version: { const: 1 }, createdAt: timestamp,
    kdf: object({ name: { const: 'scrypt' }, N: { const: 16384 }, r: { const: 8 }, p: { const: 1 }, salt: string }, ['name', 'N', 'r', 'p', 'salt']),
    cipher: object({ name: { const: 'aes-256-gcm' }, iv: string, tag: string, data: string }, ['name', 'iv', 'tag', 'data']), summary: object(summary),
  }, ['format', 'version', 'kdf', 'cipher']),
  PlanInput: object(importProperties, ['recoveryPackage', 'password']),
  ApplyInput: object({ ...importProperties, planToken: { type: 'string', maxLength: 2048 } }, ['recoveryPackage', 'password', 'planToken']),
  ConfigurationPlan: object({ ...summary, canApply: boolean, planToken: nullableString, expiresAt: timestamp, revision: string,
    changes: object({ subscriptions: delta, nodes: delta, ports: delta }, ['subscriptions', 'nodes', 'ports']),
    missingNodes: array(object({ port: integer, nodeIds: array(string) }, ['port', 'nodeIds'])),
    unavailableNodes: array(object({ port: integer, nodeIds: array(string) }, ['port', 'nodeIds'])),
    errors: array(string),
  }, ['canApply', 'planToken', 'changes', 'missingNodes', 'unavailableNodes', 'errors', 'revision']),
  RecoveryResult: object({ ...summary, reloaded: boolean, reloadRequired: boolean }, ['subscriptions', 'nodes', 'ports']),
}

export function buildOpenApi() {
  const paths = {}
  for (const operation of API_OPERATIONS) {
    const apiPath = operation.path.replace(/:([a-z]+)/g, '{$1}')
    const parameters = [...operation.path.matchAll(/:([a-z]+)/g)].map(([, name]) => ({ name, in: 'path', required: true, schema: name === 'port' ? { type: 'integer', minimum: 1024, maximum: 65535 } : { type: 'string', minLength: 1 } }))
    paths[apiPath] ||= {}
    paths[apiPath][operation.method] = {
      operationId: operation.operationId, summary: operation.summary,
      'x-required-scopes': operation.scopes,
      description: `Bearer 令牌必须同时具有：${operation.scopes.join(', ')}。浏览器管理会话也可使用。`,
      ...(parameters.length ? { parameters } : {}),
      ...(operation.input ? { requestBody: { required: true, content: { 'application/json': { schema: ref(operation.input) } } } } : {}),
      responses: {
        [operation.status]: { description: 'Success', ...(operation.output ? { content: { 'application/json': { schema: ref(operation.output) } } } : {}) },
        ...Object.fromEntries([400, 401, 403, 404, 409, 413, 429, 500, 501, 502, 503].map(status => [status, { description: 'Structured API error; inspect error.code and error.requestId.', content: { 'application/json': { schema: ref('Error') } } }])),
      },
    }
  }
  return {
    openapi: '3.1.1', info: { title: 'Proxy Port Manager Automation API', version: '1.0.0', description: 'Stable /api/v1 contract. Additive response fields are allowed. No bearer access to unversioned UI APIs. Configuration plans expire after 10 minutes or on restart; apply returns 409 if state changed.' },
    servers: [{ url: '/api/v1' }], security: [{ bearerAuth: [] }, { browserSession: [] }], paths,
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'ppm opaque token' }, browserSession: { type: 'apiKey', in: 'cookie', name: 'ppm_session' } }, schemas: API_SCHEMAS },
  }
}
