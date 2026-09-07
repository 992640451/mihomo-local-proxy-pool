import { useEffect, useMemo, useState } from 'react'
import { apiErrorMessage, apiFetch } from '../api.js'

async function jsonRequest(path, options) {
  const response = await apiFetch(path, options), payload = await response.json()
  if (!response.ok) throw new Error(apiErrorMessage(payload, 'Roxy 浏览器配置读取失败'))
  return payload
}

function pairValue(item) { return `${item.workspaceId}::${item.projectId || ''}` }

export function RoxyPortBinding({ port, value, onChange }) {
  const [config, setConfig] = useState(null), [workspaces, setWorkspaces] = useState([]), [windows, setWindows] = useState([]),
    [pair, setPair] = useState(''), [loading, setLoading] = useState(true), [windowsBusy, setWindowsBusy] = useState(false),
    [error, setError] = useState(''), [manual, setManual] = useState({ workspaceId: '', projectId: '', dirId: '', windowName: '' })
  const selectedWorkspace = useMemo(() => workspaces.find(item => pairValue(item) === pair), [workspaces, pair])

  useEffect(() => {
    const controller = new AbortController()
    ;(async () => {
      setLoading(true); setError('')
      try {
        const [nextConfig, current] = await Promise.all([
          jsonRequest('/browser/roxy/config', { signal: controller.signal }),
          jsonRequest(`/browser/roxy/bindings/${port}`, { signal: controller.signal }),
        ])
        if (controller.signal.aborted) return
        setConfig(nextConfig)
        onChange(current.binding || null)
        if (!nextConfig.configured) return
        const result = await jsonRequest('/browser/roxy/workspaces', { signal: controller.signal })
        if (controller.signal.aborted) return
        setWorkspaces(result.items || [])
        const selected = current.binding
          ? (result.items || []).find(item => item.workspaceId === current.binding.workspaceId && (item.projectId || '') === (current.binding.projectId || ''))
          : null
        setPair(selected ? pairValue(selected) : '')
        if (current.binding) setManual({ workspaceId: current.binding.workspaceId, projectId: current.binding.projectId || '', dirId: current.binding.dirId, windowName: current.binding.windowName })
      } catch (reason) { if (!controller.signal.aborted) setError(reason.message) }
      finally { if (!controller.signal.aborted) setLoading(false) }
    })()
    return () => controller.abort()
  }, [port])

  useEffect(() => {
    if (!selectedWorkspace) { setWindows([]); return undefined }
    const controller = new AbortController()
    setWindowsBusy(true); setError('')
    const query = new URLSearchParams({ workspaceId: selectedWorkspace.workspaceId })
    if (selectedWorkspace.projectId) query.set('projectId', selectedWorkspace.projectId)
    jsonRequest(`/browser/roxy/windows?${query}`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return
      const items = result.items || []
      setWindows(items)
      const existing = value && value.workspaceId === selectedWorkspace.workspaceId && (value.projectId || '') === (selectedWorkspace.projectId || '')
        ? items.find(item => item.dirId === value.dirId) : null
      if (!existing) onChange(null)
    }).catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
      .finally(() => { if (!controller.signal.aborted) setWindowsBusy(false) })
    return () => controller.abort()
  }, [selectedWorkspace?.workspaceId, selectedWorkspace?.projectId])

  const chooseWindow = dirId => {
    const selected = windows.find(item => item.dirId === dirId)
    if (!selected || !selectedWorkspace) return onChange(null)
    onChange({
      workspaceId: selectedWorkspace.workspaceId, projectId: selectedWorkspace.projectId || '', dirId: selected.dirId,
      windowName: selected.windowName, windowSortNum: selected.windowSortNum, syncProxy: value?.syncProxy !== false,
    })
  }
  const applyManual = () => {
    if (!manual.workspaceId.trim() || !manual.dirId.trim()) return setError('团队 ID 和窗口 ID 不能为空')
    onChange({ ...manual, workspaceId: manual.workspaceId.trim(), projectId: manual.projectId.trim(), dirId: manual.dirId.trim(), windowName: manual.windowName.trim() || manual.dirId.trim(), windowSortNum: null, syncProxy: value?.syncProxy !== false, manual: true })
    setError('')
  }

  return <section className="drawer-section roxy-binding-section">
    <div className="section-title"><div><span className="eyebrow">BROWSER BINDING</span><h3>Roxy 浏览器窗口</h3></div>{value?.dirId && <span className="settings-status connected">已选择</span>}</div>
    {loading ? <small>正在读取 Roxy 接入配置…</small> : !config?.configured ? <div className="node-warning-panel"><strong>尚未连接 Roxy</strong><p>请先到“系统设置 → 浏览器接入”填写 API Key并完成连接。</p></div> : <>
      <label className="field wide"><span>团队 / 项目</span><select value={pair} onChange={event => { setPair(event.target.value); onChange(null) }}>
        <option value="">不绑定 Roxy 窗口</option>
        {workspaces.map(item => <option key={pairValue(item)} value={pairValue(item)}>{item.workspaceName}{item.projectName ? ` / ${item.projectName}` : ''}</option>)}
      </select></label>
      {selectedWorkspace && <label className="field wide"><span>浏览器窗口</span><select value={value?.dirId || ''} disabled={windowsBusy} onChange={event => chooseWindow(event.target.value)}>
        <option value="">{windowsBusy ? '正在读取窗口…' : '请选择窗口'}</option>
        {windows.map(item => <option key={item.dirId} value={item.dirId}>{item.windowName}{item.windowSortNum !== null ? ` · #${item.windowSortNum}` : ''}{item.windowRemark ? ` · ${item.windowRemark}` : ''}</option>)}
      </select></label>}
      {value?.dirId && <label className="toggle-row"><span><strong>启动前同步代理</strong><small>自动将此窗口设置为 127.0.0.1:{port}</small></span><input type="checkbox" checked={value.syncProxy !== false} onChange={event => onChange({ ...value, syncProxy: event.target.checked })} /><i /></label>}
      <details className="roxy-manual-fields"><summary>窗口无法自动读取时手动填写</summary>
        <div className="field-row"><label className="field"><span>团队 ID</span><input value={manual.workspaceId} onChange={event => setManual(current => ({ ...current, workspaceId: event.target.value }))} /></label><label className="field"><span>项目 ID（可选）</span><input value={manual.projectId} onChange={event => setManual(current => ({ ...current, projectId: event.target.value }))} /></label></div>
        <div className="field-row"><label className="field"><span>窗口 ID</span><input value={manual.dirId} onChange={event => setManual(current => ({ ...current, dirId: event.target.value }))} /></label><label className="field"><span>窗口名称（可选）</span><input value={manual.windowName} onChange={event => setManual(current => ({ ...current, windowName: event.target.value }))} /></label></div>
        <button type="button" className="button ghost" onClick={applyManual}>使用手动信息</button>
      </details>
    </>}
    {error && <small className="proxy-session-error" role="alert">{error}</small>}
  </section>
}
