import { useCallback, useEffect, useMemo, useState } from 'react'
import { PORT_STRATEGIES, createInitialPorts, dedupePortsByPort, enrichPort, filterPorts, nextAvailablePort, normalizePort, removePortById, reorderPortNode, restorePortState, validatePortDraft } from './domain.js'

const NAV_ITEMS = [
  ['overview', '总览', 'grid'], ['ports', '代理端口', 'server'], ['nodes', '节点', 'nodes'],
  ['subscriptions', '订阅', 'file'], ['logs', '操作记录', 'clipboard'], ['settings', '系统设置', 'settings'],
]
const EMPTY_FILTERS = { provider: '全部订阅', country: '全部国家', status: '全部状态', query: '' }
const API_BASE = `${import.meta.env.BASE_URL}api`

async function apiFetch(path, options = {}) {
  const headers = new Headers(options.headers || {})
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers, credentials: 'same-origin' })
  if (response.status === 401 && !['/auth/login','/auth/session','/auth/logout'].includes(path)) window.dispatchEvent(new Event('ppm:unauthorized'))
  return response
}

function Icon({ name, size = 18 }) {
  const paths = {
    grid: <><rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><rect x="3" y="15" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/></>,
    server: <><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01M11 7h6M11 17h6"/></>,
    nodes: <><circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="18" r="2.5"/><circle cx="19" cy="18" r="2.5"/><path d="m10.4 7-4 8.5M13.6 7l4 8.5M7.5 18h9"/></>,
    file: <><path d="M6 2h9l4 4v16H6z"/><path d="M14 2v5h5M9 12h6M9 16h6"/></>,
    clipboard: <><path d="M9 5H6a2 2 0 0 0-2 2v14h16V7a2 2 0 0 0-2-2h-3"/><rect x="9" y="2" width="6" height="5" rx="1"/><path d="M8 12h8M8 16h6"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l-2.83 2.83A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1.4 1.7h-4A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-2.83-2.83A1.7 1.7 0 0 0 4.6 15 1.7 1.7 0 0 0 2.9 13.6v-4A1.7 1.7 0 0 0 4.6 8.5a1.7 1.7 0 0 0-.34-1.88l2.83-2.83A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10.4 3h4A1.7 1.7 0 0 0 15.5 4.6a1.7 1.7 0 0 0 1.88-.34l2.83 2.83A1.7 1.7 0 0 0 19.4 9c.15.38.6.6 1.7.6v4c-1.1 0-1.55.22-1.7.6Z"/></>,
    plus: <path d="M12 5v14M5 12h14"/>, search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    refresh: <><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></>, close: <path d="m5 5 14 14M19 5 5 19"/>,
    activity: <path d="M3 12h4l2.5-7 5 14 2.5-7h4"/>, trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14"/></>, check: <path d="m5 12 4 4L19 6"/>,
  }
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>
}

function Select({ value, onChange, children, ariaLabel }) {
  return <label className="select-wrap"><select value={value} onChange={e => onChange(e.target.value)} aria-label={ariaLabel}>{children}</select><span className="select-arrow">⌄</span></label>
}

function formatDuration(seconds = 0) {
  const d = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60
  return `${d ? `${d}天 ` : ''}${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
}

function PageHead({ eyebrow, title, description, action }) {
  return <div className="page-head"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{action}</div>
}

function MetricCard({ label, value, suffix, meta, icon, tone = 'cyan' }) {
  return <article className={`metric-card tone-${tone}`}><div className="metric-head"><span>{label}</span><span className="metric-status"/></div><div className="metric-body"><div><strong>{value}</strong>{suffix && <span className="metric-suffix">{suffix}</span>}</div><div className="metric-icon"><Icon name={icon} size={31}/></div></div><div className="metric-meta">{meta}</div></article>
}

function useCatalog(enabled) {
  const [state, setState] = useState({ loading: true, catalog: null, runtime: null, error: '' })
  const refresh = useCallback(async () => {
    if (!enabled) return
    setState(s => ({ ...s, loading: true, error: '' }))
    try {
      const [catalogRes, runtimeRes] = await Promise.all([apiFetch('/subscriptions/catalog'), apiFetch('/runtime')])
      if (!catalogRes.ok || !runtimeRes.ok) throw new Error('后端接口返回异常')
      setState({ loading: false, catalog: await catalogRes.json(), runtime: await runtimeRes.json(), error: '' })
    } catch (error) { setState(s => ({ ...s, loading: false, error: error.message })) }
  }, [enabled])
  useEffect(() => { if (enabled) refresh() }, [enabled, refresh])
  return { ...state, refresh }
}

function LoginScreen({ onLogin }) {
  const [username,setUsername]=useState(''), [password,setPassword]=useState(''), [remember,setRemember]=useState(true), [error,setError]=useState(''), [submitting,setSubmitting]=useState(false)
  const submit=async event=>{event.preventDefault();setSubmitting(true);setError('');try{const response=await apiFetch('/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password,remember})});if(!response.ok)throw new Error(response.status===429?'尝试次数过多，请稍后再试':'账号或密码不正确');onLogin()}catch(e){setError(e.message)}finally{setSubmitting(false)}}
  return <main className="login-screen"><section className="login-card"><div className="login-brand"><span className="brand-mark"><i/><i/><i/></span><div><span className="eyebrow">SECURE ACCESS</span><h1>代理端口管理</h1></div></div><p>请输入账号和密码以读取服务器代理配置。</p><form onSubmit={submit}><label className="login-field"><span>账号</span><input autoFocus autoComplete="username" value={username} onChange={e=>setUsername(e.target.value)} required/></label><label className="login-field"><span>密码</span><input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required/></label><label className="remember-row"><input type="checkbox" checked={remember} onChange={e=>setRemember(e.target.checked)}/><span className="remember-check"><Icon name="check" size={12}/></span><span><strong>记住密码</strong><small>在此设备上保持登录 30 天</small></span></label>{error&&<div className="login-error">{error}</div>}<button className="button primary login-submit" disabled={submitting}>{submitting?'校验中…':'登录'}</button></form><small>密码不会写入浏览器存储；系统仅保存可随时注销的安全登录凭证</small></section></main>
}

function PortDrawer({ mode, port, ports, nodes, providers, countries, onClose, onSave }) {
  const source = normalizePort(mode === 'edit' && port ? port : { port: nextAvailablePort(ports) ?? '', protocol: 'Mixed', nodeIds: [], strategy: 'fallback', enabled: true })
  const [draft, setDraft] = useState(source), selectedNodes = draft.nodeIds.map(id => nodes.find(node => node.id === id)).filter(Boolean)
  const [provider, setProvider] = useState('全部订阅'), [country, setCountry] = useState('全部国家'), [query, setQuery] = useState(''), [error, setError] = useState('')
  const visible = nodes.filter(n => (provider === '全部订阅' || n.provider === provider) && (country === '全部国家' || n.country === country) && (!query || n.name.toLowerCase().includes(query.toLowerCase())))
  const update = patch => { setDraft(current => normalizePort({ ...current, ...patch })); setError('') }
  const toggleNode = nodeId => update({ nodeIds: draft.nodeIds.includes(nodeId) ? draft.nodeIds.filter(id => id !== nodeId) : [...draft.nodeIds, nodeId] })
  const moveNode = (nodeId, direction) => update({ nodeIds: reorderPortNode(draft.nodeIds, nodeId, direction) })
  const option = (key, value) => update({ strategyOptions: { ...draft.strategyOptions, [key]: value } })
  const submit = () => { const message = validatePortDraft(draft, ports, mode === 'edit' ? port.id : null); if (message) return setError(message); onSave(normalizePort({ ...draft, port: Number(draft.port) })) }
  return <aside className="drawer pool-drawer"><div className="drawer-head"><div><span className="eyebrow">PORT POOL</span><h2>{mode === 'edit' ? '修改代理端口' : '新建代理端口'}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><Icon name="close"/></button></div><div className="drawer-scroll">
    <section className="drawer-section"><div className="field-row"><label className="field"><span>端口</span><input value={draft.port} onChange={e => update({port:e.target.value})}/></label><label className="field"><span>协议</span><Select value={draft.protocol} onChange={protocol => update({protocol})}><option>Mixed</option><option>HTTP</option><option>SOCKS5</option></Select></label></div><label className="toggle-row"><span><strong>启用配置</strong><small>标记该端口为启用</small></span><input type="checkbox" checked={draft.enabled} onChange={e => update({enabled:e.target.checked})}/><i/></label></section>
    <section className="drawer-section"><div className="section-title"><div><span className="eyebrow">ROUTE STRATEGY</span><h3>节点使用方式</h3></div></div><div className="strategy-grid">{Object.entries(PORT_STRATEGIES).map(([id,meta])=><button type="button" className={`strategy-card ${draft.strategy===id?'selected':''}`} key={id} onClick={()=>update({strategy:id})}><strong>{meta.label}</strong><small>{meta.description}</small></button>)}</div></section>
    {draft.strategy !== 'select' && <section className="drawer-section strategy-options"><div className="section-title"><div><span className="eyebrow">HEALTH CHECK</span><h3>健康检查</h3></div></div><label className="field wide"><span>检测地址</span><input value={draft.strategyOptions.healthCheckUrl} onChange={e=>option('healthCheckUrl',e.target.value)}/></label><div className="field-row compact"><label className="field"><span>周期（秒）</span><input type="number" min="10" value={draft.strategyOptions.intervalSeconds} onChange={e=>option('intervalSeconds',Number(e.target.value))}/></label><label className="field"><span>超时（毫秒）</span><input type="number" min="500" value={draft.strategyOptions.timeoutMs} onChange={e=>option('timeoutMs',Number(e.target.value))}/></label></div></section>}
    <section className="drawer-section selected-pool"><div className="section-title"><div><span className="eyebrow">SELECTED POOL</span><h3>已选择节点</h3></div><span>{selectedNodes.length} 个</span></div>{selectedNodes.length ? <div className="pool-order">{selectedNodes.map((node,index)=><div className="pool-node" key={node.id}><b>{index===0?'主':index}</b><span className="flag">{node.flag}</span><span className="node-copy"><strong>{node.name}</strong><small>{index===0?'当前首选':'备用/候选'} · {node.country}</small></span><span className="order-actions"><button type="button" disabled={!index} onClick={()=>moveNode(node.id,-1)} aria-label="上移">↑</button><button type="button" disabled={index===selectedNodes.length-1} onClick={()=>moveNode(node.id,1)} aria-label="下移">↓</button><button type="button" onClick={()=>toggleNode(node.id)} aria-label="移除">×</button></span></div>)}</div> : <div className="pool-empty">从下方目录选择一个或多个节点</div>}</section>
    <section className="drawer-section"><div className="section-title"><div><span className="eyebrow">ROUTE TARGETS</span><h3>选择订阅节点</h3></div><span>{visible.length} 个</span></div><div className="node-filters"><Select value={provider} onChange={setProvider}><option>全部订阅</option>{providers.map(p=><option key={p.id}>{p.name}</option>)}</Select><Select value={country} onChange={setCountry}><option>全部国家</option>{countries.map(c=><option key={c.code}>{c.name}</option>)}</Select></div><label className="search small"><Icon name="search"/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索节点"/></label><div className="node-list">{visible.map(node=>{const selected=draft.nodeIds.includes(node.id);return <button type="button" className={`node-option ${selected?'selected':''}`} key={node.id} onClick={()=>toggleNode(node.id)}><span className="checkbox"><Icon name="check" size={11}/></span><span className="flag">{node.flag}</span><span className="node-copy"><strong>{node.name}</strong><small>{node.provider} · {node.country}</small></span>{selected&&<span className="picked-index">#{draft.nodeIds.indexOf(node.id)+1}</span>}</button>})}</div></section>
  </div>{error&&<div className="form-error">{error}</div>}<div className="drawer-footer"><button className="button ghost" onClick={onClose}>取消</button><button className="button primary" onClick={submit}><Icon name="check"/>保存配置</button></div></aside>
}


function Overview({ catalog, runtime, ports }) {
  return <div className="page-stack"><PageHead eyebrow="LIVE CONFIGURATION" title="系统总览" description="所有统计均来自当前订阅配置和本次服务进程。"/><section className="metrics-grid"><MetricCard label="订阅节点" value={catalog.nodes.length} suffix="个" icon="nodes" meta={`${catalog.providers.length} 个远程订阅`}/><MetricCard label="识别国家/地区" value={catalog.countries.length} suffix="个" icon="grid" meta="按当前节点名称动态归类"/><MetricCard label="已启用端口配置" value={ports.filter(p=>p.enabled).length} suffix={`/ ${ports.length}`} icon="server" meta="浏览器本地持久化配置"/><MetricCard label="服务进程运行时长" value={formatDuration(runtime.processUptimeSeconds)} icon="activity" meta={`${runtime.hostname} · ${runtime.platform}`}/></section><section className="data-card"><h2>国家/地区分布</h2><div className="country-grid">{catalog.countries.map(c=><div className="country-card" key={c.code}><span>{c.flag}</span><div><strong>{c.name}</strong><small>{c.code}</small></div><b>{c.count}</b></div>)}</div></section></div>
}

function PortsPage({ ports, setPorts, nodes, providers, countries, addLog }) {
  const [filters,setFilters]=useState(EMPTY_FILTERS), [drawer,setDrawer]=useState({open:false,mode:'new',id:null}), [testing,setTesting]=useState(null), [deleting,setDeleting]=useState(null), [applying,setApplying]=useState(false), [applyError,setApplyError]=useState('')
  const enriched=ports.map(p=>enrichPort(p,nodes)), visible=filterPorts(ports,filters,nodes).map(p=>enrichPort(p,nodes)), selected=enriched.find(p=>p.id===drawer.id)
  const save=async rawDraft=>{
    const draft=normalizePort(rawDraft)
    setApplying(true);setApplyError('')
    try {
      const response=await apiFetch(`/ports/${draft.port}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({nodeId:draft.nodeId,protocol:draft.protocol,enabled:draft.enabled})})
      const result=await response.json()
      if(!response.ok)throw new Error(result.detail||result.error||'端口配置应用失败')
      const applied={...draft,id:drawer.mode==='edit'?drawer.id:`mihomo-listener-${draft.port}`,managedBy:result.embeddedCore?'embedded-mihomo':'mihomo',routeName:result.proxy,listenerName:`ppm-${draft.port}`,lastChecked:result.reloaded?'已写入并重载':'已写入，等待核心重载'}
      setPorts(cur=>dedupePortsByPort(drawer.mode==='edit'?cur.map(p=>p.id===drawer.id?applied:p):[...cur,applied]))
      addLog(`应用端口 ${draft.port}：${result.proxy}${result.reloaded?'，Mihomo 已重载':'，等待核心重载'}`)
      setDrawer({open:false,mode:'new',id:null})
    } catch(error) { setApplyError(error.message) }
    finally { setApplying(false) }
  }
  const test=async p=>{setTesting(p.id);setApplyError('');try{const r=await apiFetch(`/ports/${p.port}/${p.isGlobal?'egress':'test'}`),data=await r.json();if(!r.ok)throw new Error(data.detail||data.error||'端口检测失败');if(p.isGlobal){setPorts(cur=>cur.map(x=>x.id===p.id?{...x,egress:data,lastChecked:`出口检测 · ${data.flag||'🌐'} ${data.country} · ${data.latencyMs}ms`}:x));addLog(`检测全局入口 ${p.port}：${data.country} ${data.region||''} ${data.city||''} · ${data.ip}`)}else{const detail=data.proxy?` · ${data.proxy}`:'';setPorts(cur=>cur.map(x=>x.id===p.id?{...x,routeName:data.proxy||x.routeName,lastChecked:data.open?`Listener 可连接 · ${data.latencyMs}ms${detail}`:'Listener 连接失败'}:x));addLog(`检测端口 ${p.port}：${data.open?'Listener 可连接':'Listener 连接失败'}${detail}`)}}catch(error){setApplyError(error.message);setPorts(cur=>cur.map(x=>x.id===p.id?{...x,lastChecked:p.isGlobal?'出口检测失败':x.lastChecked}:x))}finally{setTesting(null)}}
  const remove=async p=>{
    if(!window.confirm(`确定删除端口 ${p.port} 的代理配置吗？`))return
    setDeleting(p.id);setApplyError('')
    try {
      if(['mihomo','embedded-mihomo'].includes(p.managedBy)){
        const response=await apiFetch(`/ports/${p.port}`,{method:'DELETE'}),result=await response.json()
        if(!response.ok)throw new Error(result.detail||result.error||'端口配置删除失败')
        if(!result.removed)throw new Error('该端口不是可删除的 Listener 配置')
        addLog(`删除端口 ${p.port}：${result.reloaded?'Mihomo 已重载':result.reloadRequired?'等待核心重载':'配置已移除'}`)
      }else addLog(`删除端口 ${p.port} 本地配置`)
      setPorts(cur=>removePortById(cur,p.id))
    }catch(error){setApplyError(error.message)}
    finally{setDeleting(null)}
  }
  return <div className="page-stack"><PageHead eyebrow="PORT POOLS" title="代理端口" description="端口由本服务内置的独立 Mihomo 核心管理，可直接使用任意订阅节点，无需切换 Clash Verge 当前订阅。"/>{applyError&&<div className="toast danger"><span>!</span>{applyError}</div>}<section className="control-panel"><div className="toolbar"><button className="button create" onClick={()=>setDrawer({open:true,mode:'new',id:null})}>新建端口池<Icon name="plus"/></button><Select value={filters.provider} onChange={provider=>setFilters({...filters,provider})}><option>全部订阅</option>{providers.map(p=><option key={p.id}>{p.name}</option>)}</Select><Select value={filters.country} onChange={country=>setFilters({...filters,country})}><option>全部国家</option>{countries.map(c=><option key={c.code}>{c.name}</option>)}</Select><Select value={filters.status} onChange={status=>setFilters({...filters,status})}><option>全部状态</option><option>在线</option><option>已停用</option></Select><label className="search"><Icon name="search"/><input value={filters.query} onChange={e=>setFilters({...filters,query:e.target.value})} placeholder="搜索端口 / 策略 / 节点 / 国家"/></label></div><div className="table-wrap"><table className="ports-table"><colgroup><col className="col-port"/><col className="col-protocol"/><col className="col-provider"/><col className="col-country"/><col className="col-route"/><col className="col-check"/><col className="col-status"/><col className="col-actions"/></colgroup><thead><tr><th>端口</th><th>协议</th><th>订阅</th><th>国家</th><th>节点池策略</th><th>Listener 检测</th><th>配置状态</th><th>操作</th></tr></thead><tbody>{visible.map(p=>{const providerNames=[...new Set(p.nodes.map(n=>n.provider))],countryNames=[...new Set(p.nodes.map(n=>n.country))];return <tr key={p.id}><td><strong className="mono">{p.port}</strong></td><td>{p.protocol}</td><td title={p.isGlobal?'Mihomo 核心':providerNames.join('、')}>{p.isGlobal?'Mihomo 核心':providerNames[0]}{!p.isGlobal&&providerNames.length>1?` +${providerNames.length-1}`:''}</td><td><span className="country">{p.isGlobal?(p.egress?`${p.egress.flag||'🌐'} ${p.egress.country}`:'🌐 待检测'):`${p.node?.flag||''} ${countryNames[0]||''}${countryNames.length>1?` +${countryNames.length-1}`:''}`}</span></td><td><div className="pool-summary"><strong>{p.routeName||`${p.strategyMeta.label} · ${p.nodes.length} 节点`}</strong><small>{p.isGlobal?(p.egress?`当前出口：${p.egress.region||p.egress.country}${p.egress.city?` · ${p.egress.city}`:''} · ${p.egress.ip}`:'点击检测获取当前出口国家'):p.node?`当前首选：${p.node.name}`:'无可用节点'}</small></div></td><td className="check-cell">{p.lastChecked||'未检测'}</td><td className="status-cell"><span className={`status-pill ${p.enabled?'online':'offline'}`}>{p.isGlobal?'Mihomo 全局入口':p.managedBy==='embedded-mihomo'?'内置核心监听':p.managedBy==='mihomo'?'Mihomo 监听':p.enabled?'已启用':'已停用'}</span></td><td className="actions-cell"><div className="actions">{!p.isGlobal&&<button disabled={applying||deleting===p.id} onClick={()=>setDrawer({open:true,mode:'edit',id:p.id})}>{applying?'应用中':'修改'}</button>}<button disabled={testing===p.id||deleting===p.id} onClick={()=>test(p)}>{testing===p.id?'检测中':'检测'}</button>{!p.isGlobal&&<button className="delete" disabled={deleting===p.id} onClick={()=>remove(p)}>{deleting===p.id?'删除中':'删除'}</button>}</div></td></tr>})}</tbody></table>{!visible.length&&<div className="empty-state">没有符合条件的端口</div>}</div></section>{drawer.open&&<PortDrawer mode={drawer.mode} port={selected} ports={ports} nodes={nodes} providers={providers} countries={countries} onClose={()=>setDrawer({...drawer,open:false})} onSave={save}/>}</div>
}

function NodesPage({ catalog }) {
  const [provider,setProvider]=useState('全部订阅'),[country,setCountry]=useState('全部国家'),[query,setQuery]=useState('')
  const nodes=catalog.nodes.filter(n=>(provider==='全部订阅'||n.provider===provider)&&(country==='全部国家'||n.country===country)&&(!query||n.name.toLowerCase().includes(query.toLowerCase())))
  return <div className="page-stack"><PageHead eyebrow="SUBSCRIPTION NODES" title="节点目录" description={`从订阅文件实时读取 ${catalog.nodes.length} 个节点。`}/><section className="control-panel"><div className="toolbar"><Select value={provider} onChange={setProvider}><option>全部订阅</option>{catalog.providers.map(p=><option key={p.id}>{p.name}</option>)}</Select><Select value={country} onChange={setCountry}><option>全部国家</option>{catalog.countries.map(c=><option key={c.code}>{c.name}</option>)}</Select><label className="search"><Icon name="search"/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索节点名称"/></label></div><div className="table-wrap"><table><thead><tr><th>节点</th><th>订阅</th><th>国家/地区</th><th>代码</th><th>数据来源</th></tr></thead><tbody>{nodes.map(n=><tr key={n.id}><td><strong>{n.name}</strong></td><td>{n.provider}</td><td>{n.flag} {n.country}</td><td><span className="code">{n.code}</span></td><td>订阅配置</td></tr>)}</tbody></table></div><footer className="table-footer">当前显示 {nodes.length} / {catalog.nodes.length} 个节点</footer></section></div>
}

function SubscriptionsPage({ catalog, refresh }) {
  return <div className="page-stack"><PageHead eyebrow="REMOTE PROFILES" title="订阅" description="远程订阅清单与节点数量来自 Clash Verge Rev 的 profiles.yaml。" action={<button className="button primary" onClick={refresh}><Icon name="refresh"/>重新读取配置</button>}/><div className="subscription-grid">{catalog.providers.map(p=><article className="data-card" key={p.id}><span className="eyebrow">REMOTE / {p.id}</span><h2>{p.name}</h2><strong className="big-number">{p.nodeCount}</strong><span> 个节点</span><p className="mono path-text">profiles/{p.file}</p></article>)}</div><section className="data-card"><h2>配置同步信息</h2><dl className="detail-list"><div><dt>数据源</dt><dd>{catalog.source}</dd></div><div><dt>最后读取</dt><dd>{new Date(catalog.updatedAt).toLocaleString('zh-CN',{hour12:false})}</dd></div><div><dt>节点总数</dt><dd>{catalog.nodes.length}</dd></div><div><dt>国家/地区</dt><dd>{catalog.countries.length}</dd></div></dl></section></div>
}

function LogsPage({ logs, clear }) {
  return <div className="page-stack"><PageHead eyebrow="LOCAL AUDIT" title="操作记录" description="记录当前浏览器内发生的配置读取与端口操作。" action={<button className="button ghost" onClick={clear}>清空记录</button>}/><section className="data-card log-list">{logs.length?logs.map(log=><div className="log-row" key={log.id}><span className="status-dot"/><time>{new Date(log.at).toLocaleString('zh-CN',{hour12:false})}</time><strong>{log.text}</strong></div>):<div className="empty-state">暂无操作记录</div>}</section></div>
}

function SettingsPage({ runtime, refreshSeconds, setRefreshSeconds, resetPorts, refresh }) {
  return <div className="page-stack"><PageHead eyebrow="SYSTEM SETTINGS" title="系统设置" description="配置自动刷新和本地端口数据。"/><section className="data-card settings-card"><label className="setting-row"><span><strong>订阅自动刷新</strong><small>按设定周期重新读取本地订阅配置</small></span><Select value={String(refreshSeconds)} onChange={v=>setRefreshSeconds(Number(v))}><option value="0">关闭</option><option value="30">30 秒</option><option value="60">1 分钟</option><option value="300">5 分钟</option></Select></label><div className="setting-row"><span><strong>立即刷新</strong><small>重新读取 profiles.yaml 及其远程订阅文件</small></span><button className="button primary" onClick={refresh}>读取配置</button></div><div className="setting-row"><span><strong>重置端口配置</strong><small>按当前订阅节点恢复默认端口映射</small></span><button className="button danger" onClick={resetPorts}>恢复默认</button></div></section><section className="data-card"><h2>运行环境</h2><dl className="detail-list"><div><dt>主机</dt><dd>{runtime.hostname}</dd></div><div><dt>平台</dt><dd>{runtime.platform}</dd></div><div><dt>服务进程运行时长</dt><dd>{formatDuration(runtime.processUptimeSeconds)}</dd></div><div><dt>系统运行时长</dt><dd>{formatDuration(runtime.systemUptimeSeconds)}</dd></div></dl></section></div>
}

export default function App() {
  const [authenticated,setAuthenticated]=useState(null), { loading,catalog,runtime,error,refresh }=useCatalog(authenticated===true), [active,setActive]=useState('overview'), [ports,setPorts]=useState([]), [initialized,setInitialized]=useState(false), [logs,setLogs]=useState([]), [refreshSeconds,setRefreshSecondsState]=useState(()=>Number(localStorage.getItem('ppm:refreshSeconds')||0)), [tick,setTick]=useState(0)
  const addLog=useCallback(text=>setLogs(current=>[{id:crypto.randomUUID(),at:Date.now(),text},...current].slice(0,100)),[])
  useEffect(()=>{if(!catalog)return;let saved=[];try{saved=JSON.parse(localStorage.getItem('proxy-port-manager:v3:ports')||'[]')}catch{};const listeners=catalog.listeners||[], restored=restorePortState(catalog.nodes,listeners,saved);setPorts(restored);setInitialized(true);addLog(`${initialized?'刷新':'读取'} ${catalog.providers.length} 个订阅、${catalog.nodes.length} 个节点、${catalog.countries.length} 个国家/地区、${listeners.length} 个内置核心监听；端口配置去重后 ${restored.length} 个`)},[catalog,addLog])
  useEffect(()=>{if(initialized)localStorage.setItem('proxy-port-manager:v3:ports',JSON.stringify(dedupePortsByPort(ports)))},[ports,initialized])
  useEffect(()=>{if(!refreshSeconds)return;const id=setInterval(refresh,refreshSeconds*1000);return()=>clearInterval(id)},[refreshSeconds,refresh])
  useEffect(()=>{const id=setInterval(()=>setTick(v=>v+1),1000);return()=>clearInterval(id)},[])
  useEffect(()=>{let live=true;apiFetch('/auth/session').then(response=>{if(live)setAuthenticated(response.ok)}).catch(()=>{if(live)setAuthenticated(false)});return()=>{live=false}},[])
  useEffect(()=>{const logout=()=>{setAuthenticated(false);setInitialized(false)};window.addEventListener('ppm:unauthorized',logout);return()=>window.removeEventListener('ppm:unauthorized',logout)},[])
  const setRefreshSeconds=v=>{setRefreshSecondsState(v);localStorage.setItem('ppm:refreshSeconds',String(v));addLog(`订阅自动刷新设置为 ${v?`${v} 秒`:'关闭'}`)}
  const logout=async()=>{try{await apiFetch('/auth/logout',{method:'POST'})}finally{setAuthenticated(false);setInitialized(false)}}
  if(authenticated===null)return <div className="loading-screen"><span className="brand-mark"><i/><i/><i/></span><strong>正在恢复登录状态…</strong></div>
  if(!authenticated)return <LoginScreen onLogin={()=>setAuthenticated(true)}/>
  if(loading&&!catalog)return <div className="loading-screen"><span className="brand-mark"><i/><i/><i/></span><strong>正在读取订阅配置…</strong></div>
  if(error&&!catalog)return <div className="loading-screen error-screen"><strong>数据读取失败</strong><p>{error}</p><button className="button primary" onClick={refresh}>重试</button></div>
  const liveRuntime={...runtime,processUptimeSeconds:(runtime?.processUptimeSeconds||0)+tick}
  const pages={overview:<Overview catalog={catalog} runtime={liveRuntime} ports={ports}/>,ports:<PortsPage ports={ports} setPorts={setPorts} nodes={catalog.nodes} providers={catalog.providers} countries={catalog.countries} addLog={addLog}/>,nodes:<NodesPage catalog={catalog}/>,subscriptions:<SubscriptionsPage catalog={catalog} refresh={refresh}/>,logs:<LogsPage logs={logs} clear={()=>setLogs([])}/>,settings:<SettingsPage runtime={liveRuntime} refreshSeconds={refreshSeconds} setRefreshSeconds={setRefreshSeconds} refresh={refresh} resetPorts={()=>{setPorts(createInitialPorts(catalog.nodes,catalog.listeners||[]));addLog('恢复服务端端口配置')}}/>}
  return <div className="app-shell" data-app="proxy-port-manager"><header className="topbar"><div className="brand"><span className="brand-mark"><i/><i/><i/></span><strong>代理端口管理</strong><span className="version">CONFIG / LIVE</span></div><div className="system-strip"><span><i className="status-dot"/>配置服务正常</span><span>服务运行&nbsp; {formatDuration(liveRuntime.processUptimeSeconds)}</span><span>订阅&nbsp; {catalog.providers.length} · 节点&nbsp; {catalog.nodes.length} · 国家/地区&nbsp; {catalog.countries.length}</span></div><div className="topbar-actions"><button className="text-button" onClick={logout}>退出登录</button><button className="icon-button refresh" onClick={refresh} aria-label="刷新"><Icon name="refresh"/></button></div></header><aside className="sidebar"><nav>{NAV_ITEMS.map(([id,label,icon])=><button key={id} className={active===id?'active':''} onClick={()=>setActive(id)}><Icon name={icon}/><span>{label}</span>{id==='ports'&&<b>{ports.length}</b>}</button>)}</nav><div className="sidebar-foot"><div className="server-health"><i/><span><strong>{runtime.hostname}</strong><small>{catalog.source}</small></span></div></div></aside><main className="workspace">{pages[active]}</main>{error&&<div className="toast danger"><span>!</span>{error}</div>}</div>
}



