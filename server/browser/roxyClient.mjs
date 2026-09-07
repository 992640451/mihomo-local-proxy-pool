function clean(value, maximum = 256) {
  const result = String(value ?? '').trim()
  if (!result || result.length > maximum || /[\u0000-\u001f\u007f]/.test(result)) throw new Error('Roxy API 参数无效')
  return result
}

function rows(payload) {
  return Array.isArray(payload?.data?.rows) ? payload.data.rows : []
}

export class RoxyClient {
  constructor({ host = '127.0.0.1', port = 50000, token, fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    const numericPort = Number(port)
    if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) throw new Error('Roxy API 端口必须是 1–65535 的整数')
    if (!String(token || '').trim()) throw new Error('尚未配置 Roxy API Key')
    this.baseUrl = `http://${host}:${numericPort}`
    this.token = String(token).trim()
    this.fetch = fetchImpl
    this.timeoutMs = timeoutMs
  }

  async request(pathname, { method = 'GET', body, timeoutMs = this.timeoutMs } = {}) {
    let response
    try {
      response = await this.fetch(`${this.baseUrl}${pathname}`, {
        method, redirect: 'error',
        headers: { token: this.token, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw Object.assign(new Error('无法连接 Roxy 本地 API，请确认 Roxy 已运行并开启 API'), { code: 'ROXY_UNREACHABLE', status: 502, cause: error })
    }
    let payload
    try { payload = await response.json() }
    catch { throw Object.assign(new Error(`Roxy API 返回了无法识别的响应（HTTP ${response.status}）`), { code: 'ROXY_INVALID_RESPONSE', status: 502 }) }
    const successCode = payload?.code === 0 || payload?.code === '0'
    if (!response.ok || !successCode) {
      const detail = String(payload?.msg || payload?.message || `HTTP ${response.status}`).slice(0, 300)
      throw Object.assign(new Error(`Roxy API 操作失败：${detail}`), { code: response.status === 401 || response.status === 403 ? 'ROXY_AUTH_FAILED' : 'ROXY_API_FAILED', status: 502 })
    }
    return payload
  }

  async listWorkspaces() {
    const result = [], seen = new Set(), pageSize = 100
    for (let page = 1; page <= 20; page++) {
      const payload = await this.request(`/browser/workspace?page_index=${page}&page_size=${pageSize}`), pageRows = rows(payload)
      for (const workspace of pageRows) {
        const workspaceId = String(workspace?.id ?? workspace?.workspaceId ?? '').trim()
        if (!workspaceId || seen.has(workspaceId)) continue
        seen.add(workspaceId)
        const workspaceName = String(workspace.workspaceName || workspace.name || workspaceId)
        const projects = Array.isArray(workspace.project_details) ? workspace.project_details : []
        if (!projects.length) result.push({ workspaceId, workspaceName, projectId: '', projectName: '' })
        for (const project of projects) {
          result.push({
            workspaceId, workspaceName,
            projectId: String(project?.projectId ?? project?.id ?? '').trim(),
            projectName: String(project?.projectName || project?.name || ''),
          })
        }
      }
      const total = Number(payload?.data?.total)
      if (!pageRows.length || pageRows.length < pageSize || (Number.isFinite(total) && seen.size >= total)) break
    }
    return result
  }

  async listWindows({ workspaceId, projectId = '' }) {
    const id = clean(workspaceId), project = String(projectId || '').trim()
    const output = [], seen = new Set(), pageSize = 100
    for (let page = 1; page <= 20; page++) {
      const query = new URLSearchParams({ workspaceId: id, page_index: String(page), page_size: String(pageSize) })
      if (project) query.set('projectIds', project)
      const payload = await this.request(`/browser/list_v3?${query}`)
      const pageRows = rows(payload)
      for (const item of pageRows) {
        const dirId = String(item?.dirId ?? '').trim()
        if (!dirId || seen.has(dirId)) continue
        seen.add(dirId)
        output.push({
          dirId,
          windowName: String(item.windowName || `窗口 ${item.windowSortNum ?? dirId}`),
          windowSortNum: Number.isInteger(Number(item.windowSortNum)) ? Number(item.windowSortNum) : null,
          windowRemark: String(item.windowRemark || ''),
          projectId: String(item.projectId || project),
          coreType: String(item.coreType || ''),
          os: String(item.os || ''),
        })
      }
      const total = Number(payload?.data?.total)
      if (!pageRows.length || pageRows.length < pageSize || (Number.isFinite(total) && output.length >= total)) break
    }
    return output
  }

  async running(dirId) {
    const payload = await this.request(`/browser/connection_info?${new URLSearchParams({ dirIds: clean(dirId) })}`)
    if (!Array.isArray(payload.data)) throw Object.assign(new Error('Roxy 未返回可识别的窗口运行状态'), { code: 'ROXY_INVALID_RESPONSE', status: 502 })
    return payload.data.some(item => String(item?.dirId || '') === String(dirId))
  }

  async setProxy(binding, { port, protocol = 'HTTP' }) {
    const category = String(protocol).toUpperCase() === 'SOCKS5' ? 'SOCKS5' : 'HTTP'
    await this.request('/browser/mdf', { method: 'POST', body: {
      workspaceId: clean(binding.workspaceId), dirId: clean(binding.dirId),
      proxyInfo: { moduleId: '0', proxyMethod: 'custom', proxyCategory: category, ipType: 'IPV4', host: '127.0.0.1', port: String(port) },
    }, timeoutMs: 30000 })
  }

  async open(binding) {
    return this.request('/browser/open', { method: 'POST', body: {
      workspaceId: clean(binding.workspaceId), dirId: clean(binding.dirId), args: [], forceOpen: false, headless: false,
    }, timeoutMs: 60000 })
  }
}
