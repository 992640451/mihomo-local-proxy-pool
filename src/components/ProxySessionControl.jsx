import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch, apiErrorMessage } from '../api.js'
import './proxySession.css'

const labels = { idle: '未开始使用', preparing: '正在准备', activating: '正在绑定节点', active: '本次节点已固定', ending: '正在结束', 'recovery-required': '需要结束并重新开始' }

export function ProxySessionControl({ port, onChange }) {
  const [status, setStatus] = useState(null), [bindingStatus, setBindingStatus] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const launch = useRef(null), changed = useRef(onChange)
  changed.current = onChange
  const load = useCallback(async signal => {
    const [response, bindingResponse] = await Promise.all([
      apiFetch(`/ports/${port}/session`, { signal }),
      apiFetch(`/browser/roxy/bindings/${port}`, { signal }),
    ])
    const result = await response.json()
    if (!response.ok) throw new Error(apiErrorMessage(result))
    if (bindingResponse.ok) setBindingStatus(await bindingResponse.json())
    setStatus(result)
    changed.current(result.session)
    return result
  }, [port])
  useEffect(() => {
    const controller = new AbortController()
    let timer
    const poll = async () => {
      try { await load(controller.signal) } catch (cause) { if (!controller.signal.aborted) setError(cause.message) }
      if (!controller.signal.aborted) timer = setTimeout(poll, 5000)
    }
    poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [load])
  const act = async end => {
    setBusy(true); setError('')
    try {
      if (!end && !launch.current) launch.current = crypto.randomUUID()
      const autoStart = !end && Boolean(bindingStatus?.binding)
      const response = await apiFetch(end ? `/ports/${port}/sessions/${encodeURIComponent(status.session.sessionId)}/end` : autoStart ? `/browser/roxy/bindings/${port}/start` : `/ports/${port}/sessions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(end || autoStart ? {} : { launchId: launch.current }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(apiErrorMessage(result))
      launch.current = null
      if (!end && result.state !== 'active') setError('此启动操作已结束，请重新点击开始使用')
      await load()
    } catch (cause) {
      setError(cause.message)
      // Reconcile timeouts before allowing another operation with a new launch ID.
      try { const current = await load(); if (current.state !== 'idle') launch.current = null } catch { /* Keep the same ID for a safe retry. */ }
    } finally { setBusy(false) }
  }
  const session = status?.session
  const binding = bindingStatus?.binding
  return <div className="proxy-session-control">
    <span>{labels[status?.state] || '正在读取会话'}{session?.nodeName ? ` · ${session.nodeName}` : ''}</span>
    {session?.startedAt && <small>开始于 {new Date(session.startedAt).toLocaleString()}</small>}
    <div className="proxy-session-actions">
      {session ? <button disabled={busy} onClick={() => act(true)}>{busy ? '处理中…' : '结束使用'}</button>
        : <button disabled={busy || !status} onClick={() => act(false)}>{busy ? (binding ? '正在启动…' : '正在选点…') : binding ? `启动 Roxy · ${binding.windowName}` : '开始使用'}</button>}
    </div>
    <small>{session ? (bindingStatus?.run?.state === 'running' ? 'Roxy 窗口运行中；关闭窗口后会自动结束本次使用。' : '请先关闭浏览器，再结束使用。故障时保留本次节点。') : binding ? '点击后会先固定节点、同步代理，再自动打开并监控此窗口。' : '可手动开始使用，或在修改端口时绑定 Roxy 窗口。'}</small>
    {(error || session?.error) && <small className="proxy-session-error" role="alert">{error || session.error}</small>}
  </div>
}
