import { useEffect, useState } from 'react';
import { PageHead, MetricCard, Select } from '../components/ui.jsx';
import { useObservability, observationRequest } from '../hooks/useObservability.js';
import { ObservationHistory, ObservationJob, FailureTrend, observationTime } from '../components/ObservationHistory.jsx';

export function ObservabilityPage() {
  const { data, error, refresh } = useObservability();
  const [draft, setDraft] = useState(null), [target, setTarget] = useState(''), [actionError, setActionError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { if (data && !draft) setDraft(data.settings); }, [data, draft]);
  const port = data?.ports.find(item => String(item.port) === target);
  const locked = busy || !data?.supported || data?.running || Date.now() < data?.nextAllowedAt;
  const update = (key, value) => setDraft(current => ({ ...current, [key]: value }));
  return <div className="page-stack observation-page">
    <PageHead eyebrow="OBSERVABILITY" title="可观测性" description="区分监听可连接与真实代理出口可用。数据持久化在本机；后台检测默认关闭，启用后会产生真实外部请求。" />
    {(error || actionError) && <p className="observation-error" role="alert">{actionError || error}</p>}
    {notice && <p role="status" className="observation-note">{notice}</p>}
    {data && !data.supported && <p className="observation-note">当前部署不支持主动检测；仅内置 Mihomo 模式可启用。</p>}
    {data?.supported && !data.reachable && <p className="observation-error">Mihomo 不可达：{data.error}</p>}
    <section className="metrics-grid">
      <MetricCard label="近 24 小时端口成功率" value={data?.summary.successRate == null ? '—' : `${data.summary.successRate}%`} meta="按每次独立出口连接计数" icon="activity" />
      <MetricCard label="成功 / 总连接" value={data ? `${data.summary.successes} / ${data.summary.attempts}` : '—'} meta="节点测速不混入端口成功率" icon="server" />
      <MetricCard label="端口异常连接" value={data?.summary.failures ?? '—'} meta="仅包含实际完成的检测" icon="activity" />
      <MetricCard label="后台检测" value={data?.settings.enabled ? '已开启' : '已关闭'} meta={data?.nextRunAt ? `下次 ${observationTime(data.nextRunAt)}` : '不会自动产生测试流量'} icon="settings" />
    </section>
    <section className="data-card observation-history"><h2>端口连接失败趋势</h2><FailureTrend trend={data?.summary.trend} /><p className="observation-note">近 24 个小时，左旧右新；灰色无样本，绿色全部成功，红色为失败比例。未检测不代表失败。</p></section>
    <ObservationJob data={data} onRefresh={refresh} onError={setActionError} />
    <section className="data-card observation-history">
      <h2>端口池实时状态与历史</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>端口</th><th>当前活动节点</th><th>近 24 小时成功率</th><th>连续异常检测</th><th>历史</th></tr></thead>
        <tbody>{data?.ports.map(item => <tr key={item.port}>
          <td><strong>{item.port}</strong><small className="observation-note">{item.enabled === false ? '已停用' : item.reachable ? '核心已加载' : '核心未就绪'}</small></td>
          <td>{item.activeNodeName || (item.reachable && ['round-robin', 'consistent-hashing'].includes(item.strategy) ? '按新连接分配，无单一活动节点' : '—')}</td>
          <td>{item.successRate === null ? '未检测' : `${item.successRate}%`}</td><td>{item.consecutiveFailures}</td>
          <td><button className="text-button" onClick={() => setTarget(String(item.port))}>查看 / 验证</button></td>
        </tr>)}</tbody>
      </table></div>
      {!data?.ports.length && <p className="empty-state">暂无端口池，请先创建。</p>}
      <div className="observation-actions">
        <Select ariaLabel="选择历史端口" value={target} onChange={setTarget}><option value="">选择历史端口</option>{data?.ports.map(item => <option key={item.port} value={String(item.port)}>{item.port}</option>)}</Select>
        <button className="button primary" disabled={locked || !port || port.enabled === false || !data?.reachable} onClick={async () => {
          setBusy(true); setActionError(''); setNotice('');
          try {
            const result = await observationRequest(`/ports/${port.port}/verify`, { method: 'POST', body: JSON.stringify({ attempts: data.settings.attempts }) });
            setNotice(`端口 ${port.port}：${result.successes}/${result.attempts} 成功，${result.uniqueExitCount} 个出口。`); refresh();
          } catch (cause) { setActionError(cause.message); refresh(); } finally { setBusy(false); }
        }}>{busy ? '执行中…' : `验证此端口（${data?.settings.attempts || 2} 次）`}</button>
      </div>
    </section>
    {target && <ObservationHistory key={target} kind="port" targetId={target} revision={data?.job?.finishedAt} />}
    {draft && <form className="data-card observation-settings" onSubmit={async event => {
      event.preventDefault(); setActionError(''); setNotice('');
      if ((draft.retentionDays < data.settings.retentionDays || draft.maxSamples < data.settings.maxSamples) && !window.confirm('缩短保留期或容量会清理超出限制的检测历史，无法恢复。继续保存吗？')) return;
      setBusy(true);
      try { const result = await observationRequest('/observability/settings', { method: 'PATCH', body: JSON.stringify(draft) }); setDraft(result.settings); setNotice('检测设置已保存。'); refresh(); }
      catch (cause) { setActionError(cause.message); } finally { setBusy(false); }
    }}>
      <h2>后台检测设置</h2>
      <label className="observation-toggle"><input type="checkbox" checked={draft.enabled} disabled={!data.supported} onChange={event => update('enabled', event.target.checked)} />启用低频后台检测（节点测速 + 启用端口的出口验证）</label>
      <p className="observation-note">每轮最多 100 个节点、10 个端口；超出部分按轮次轮换。节点测速默认请求 gstatic，出口查询默认请求 ipwho.is，第三方会看到代理出口 IP。关闭不会影响 Mihomo 策略自身的健康检查。</p>
      <div className="observation-setting-grid">
        {[
          ['intervalSeconds', '检测周期（秒）', 300, 86400], ['concurrency', '节点并发数', 1, 6], ['timeoutMs', '单次超时（毫秒）', 1000, 10000],
          ['attempts', '每端口连接次数', 2, 8], ['retentionDays', '历史保留（天）', 1, 30], ['maxSamples', '最大历史条数', 100, 50000],
        ].map(([key, label, min, max]) => <label key={key}>{label}<input type="number" min={min} max={max} step="1" required value={draft[key]} onChange={event => update(key, Number(event.target.value))} /><small>{min}–{max}</small></label>)}
      </div>
      <p className="observation-note">不保存订阅 URL、节点密码和完整请求日志。出口 IP 会保存在本机检测历史中，不包含在恢复包或诊断导出中。</p>
      <button className="button primary" disabled={busy}>保存检测设置</button>
    </form>}
  </div>;
}
