import { useEffect, useState } from 'react';
import { observationRequest } from '../hooks/useObservability.js';

export const observationTime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未检测';
export const healthLabel = state => ({ healthy: '健康', failed: '失败', stale: '结果过期', unknown: '未检测' })[state] || '未检测';

export function ObservationJob({ data, onRefresh, onError }) {
  const job = data?.job;
  if (!job) return null;
  const state = { running: '检测中', completed: '已完成', failed: '任务失败', cancelled: '已取消', interrupted: '被重启中断' }[job.status];
  return <div className="observation-job" role="status" aria-live="polite">
    <span>{job.source === 'scheduler' ? '后台' : '手动'}检测 · {state} · {job.completed}/{job.total} · 异常 {job.failures}</span>
    {job.status === 'running' && <button className="button ghost" onClick={async () => {
      try { await observationRequest('/observability/cancel', { method: 'POST' }); onRefresh(); } catch (error) { onError(error.message); }
    }}>取消检测</button>}
    {job.error && <small>{job.error}</small>}
  </div>;
}

export function FailureTrend({ trend = [] }) {
  return <div className="observation-trend" role="img" aria-label="最近 24 个小时异常比例趋势；灰色为无检测，绿色为全部成功，红色高度为失败比例">
    {trend.map(bucket => <div key={bucket.at} className={`trend-slot ${bucket.attempts ? 'sampled' : ''}`}
      title={`${observationTime(bucket.at)}：${bucket.attempts ? `${bucket.failures}/${bucket.attempts} 次连接失败` : '无检测'}`}>
      {bucket.attempts > 0 && <i style={{ height: `${100 * bucket.failures / bucket.attempts}%` }} />}
    </div>)}
  </div>;
}

export function ObservationHistory({ kind, targetId, revision }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  useEffect(() => {
    let stopped = false;
    const abort = new AbortController();
    setData(null); setError(''); setLoading(true);
    observationRequest(`/observability/history?${new URLSearchParams({ kind, targetId })}`, { signal: abort.signal })
      .then(result => { if (!stopped) setData(result); }, cause => { if (!stopped) setError(cause.message); })
      .finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; abort.abort(); };
  }, [kind, targetId, revision]);
  return <section className="data-card observation-history">
    <h2>{kind === 'node' ? '节点测速历史' : `端口 ${targetId} 验证历史`}</h2>
    {error && <p role="alert" className="observation-error">{error}</p>}
    {data?.summary && <>
      <p className="observation-note">近 24 小时：{data.summary.successRate === null ? '暂无样本' : `${data.summary.successRate}% 成功率，${data.summary.successes}/${data.summary.attempts} 次成功`} · 连续异常检测 {data.summary.consecutiveFailures} 次（保留期内，含部分失败）</p>
      <FailureTrend trend={data.summary.trend} />
      <p className="observation-note">左→右：近 24 小时；灰色无样本，绿色全部成功，红色为失败比例。悬停查看每小时明细。</p>
    </>}
    <div className="table-wrap"><table>
      <thead><tr><th>检测时间 / 来源</th><th>成功 / 总数</th><th>成功样本平均延迟</th><th>{kind === 'port' ? '出口分布 / 配置 / 异常' : '异常原因'}</th></tr></thead>
      <tbody>{data?.items.map(item => <tr key={item.id}>
        <td>{observationTime(item.checkedAt)}<small className="observation-note">{item.source === 'scheduler' ? '后台检测' : '手动检测'}</small></td>
        <td><span className={`health-badge ${item.failures ? 'failed' : 'healthy'}`}>{item.successes}/{item.attempts}</span></td>
        <td>{item.latencyMs === null ? '—' : `${item.latencyMs} ms`}</td>
        <td className="observation-detail">{item.distribution?.map(exit => <div key={exit.ip}>{exit.ip} · {exit.country} · {exit.count} 次</div>)}
          {item.configuration && <small>{item.configuration.protocol} · {item.configuration.strategy} · {item.configuration.nodeIds?.length || 0} 节点</small>}
          {(item.errors || (item.error ? [item.error] : [])).map((message, index) => <small key={index}>{message}</small>)}
          {kind === 'node' && !item.error && '—'}
        </td>
      </tr>)}</tbody>
    </table></div>
    {!data?.items.length && <p className="empty-state">{loading ? '正在读取历史…' : '暂无检测记录；未检测不代表失败。'}</p>}
    {data?.nextBefore && <button className="button ghost" disabled={loading} onClick={async () => {
      setLoading(true);
      try {
        const result = await observationRequest(`/observability/history?${new URLSearchParams({ kind, targetId, before: data.nextBefore })}`);
        setData(current => ({ ...result, items: [...current.items, ...result.items] }));
      } catch (cause) { setError(cause.message); } finally { setLoading(false); }
    }}>加载更早记录</button>}
  </section>;
}
