import { useState } from 'react';
import { PageHead, Select } from '../components/ui.jsx';
import { useObservability, observationRequest } from '../hooks/useObservability.js';
import { ObservationHistory, ObservationJob, healthLabel, observationTime } from '../components/ObservationHistory.jsx';

export function NodesPage({ catalog }) {
  const { data, error, refresh } = useObservability();
  const [provider, setProvider] = useState(''), [country, setCountry] = useState(''), [query, setQuery] = useState('');
  const [selected, setSelected] = useState([]), [history, setHistory] = useState(null), [actionError, setActionError] = useState(''), [busy, setBusy] = useState(false), [page, setPage] = useState(0);
  const states = new Map(data?.nodes.map(node => [node.id, node]) || []);
  const nodes = catalog.nodes.filter(node => (!provider || node.providerId === provider) && (!country || node.code === country) && (!query || node.name.toLowerCase().includes(query.toLowerCase())));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(nodes.length / 100) - 1));
  const visible = nodes.slice(currentPage * 100, currentPage * 100 + 100);
  const chosen = selected.filter(id => catalog.nodes.some(node => node.id === id));
  const locked = busy || !data?.supported || !data?.reachable || data?.running || Date.now() < data?.nextAllowedAt;
  const toggle = id => setSelected(current => current.includes(id) ? current.filter(value => value !== id) : current.length < 100 ? [...current, id] : current);
  return <div className="page-stack observation-page">
    <PageHead eyebrow="NODE HEALTH" title="节点健康" description="健康状态来自 Mihomo；页面每 5 秒读取状态，不会自动发起测速。测速衡量请求延迟，不代表下载带宽。" />
    {(error || actionError) && <p role="alert" className="observation-error">{actionError || error}</p>}
    {data && !data.supported && <p className="observation-note">当前部署不支持节点测速，请使用内置 Mihomo 模式。</p>}
    {data?.supported && !data.reachable && <p role="alert" className="observation-error">Mihomo 不可达，以下历史结果不代表当前健康状态。{data.error}</p>}
    <ObservationJob data={data} onRefresh={refresh} onError={setActionError} />
    <section className="control-panel">
      <div className="toolbar">
        <Select ariaLabel="按订阅筛选" value={provider} onChange={value => { setProvider(value); setPage(0); }}><option value="">全部订阅</option>{catalog.providers.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</Select>
        <Select ariaLabel="按国家筛选" value={country} onChange={value => { setCountry(value); setPage(0); }}><option value="">全部国家</option>{catalog.countries.map(item => <option value={item.code} key={item.code}>{item.name}</option>)}</Select>
        <label className="search"><input aria-label="搜索节点" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} placeholder="搜索节点名称" /></label>
      </div>
      <div className="observation-actions">
        <button className="button ghost" onClick={() => setSelected(visible.map(node => node.id))}>选择当前页</button>
        <button className="button ghost" onClick={() => setSelected([])}>清除选择</button>
        <button className="button primary" disabled={locked || !chosen.length} onClick={async () => {
          setBusy(true); setActionError('');
          try { await observationRequest('/observability/nodes/test', { method: 'POST', body: JSON.stringify({ nodeIds: chosen }) }); refresh(); }
          catch (cause) { setActionError(cause.message); } finally { setBusy(false); }
        }}>测速所选 {chosen.length} 个节点</button>
        <small>每批最多 100 个；完成后冷却 15 秒。</small>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>选择</th><th>节点 / 订阅</th><th>国家/地区</th><th>健康状态</th><th>最近延迟</th><th>最近检测时间</th><th>历史</th></tr></thead>
        <tbody>{visible.map(node => {
          const state = states.get(node.id);
          return <tr key={node.id}>
            <td><input type="checkbox" aria-label={`选择 ${node.name}`} checked={chosen.includes(node.id)} disabled={!chosen.includes(node.id) && chosen.length >= 100} onChange={() => toggle(node.id)} /></td>
            <td><strong>{node.name}</strong><small className="observation-note">{node.provider}</small></td>
            <td>{node.flag} {node.country}</td>
            <td><span className={`health-badge ${state?.state || 'unknown'}`}>{healthLabel(state?.state)}</span>{data?.reachable && !state?.loaded && <small className="observation-note">核心尚未加载</small>}</td>
            <td>{state?.delay == null ? '—' : `${state.delay} ms`}</td>
            <td>{observationTime(state?.checkedAt)}</td>
            <td><button className="text-button" onClick={() => setHistory(node.id)}>查看历史</button></td>
          </tr>;
        })}</tbody>
      </table></div>
      {!visible.length && <div className="empty-state">没有匹配的节点</div>}
      <footer className="table-footer observation-actions">
        <span>筛选 {nodes.length} / {catalog.nodes.length} 个节点 · 第 {currentPage + 1} 页</span>
        <button className="button ghost" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button>
        <button className="button ghost" disabled={(currentPage + 1) * 100 >= nodes.length} onClick={() => setPage(currentPage + 1)}>下一页</button>
      </footer>
    </section>
    {history && <><h2>{catalog.nodes.find(node => node.id === history)?.name || '节点'} · 手动与后台测速记录</h2><ObservationHistory key={history} kind="node" targetId={history} revision={data?.job?.finishedAt} /></>}
  </div>;
}
