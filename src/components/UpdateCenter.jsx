import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiErrorMessage, apiFetch } from '../api.js';

const remember = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
const recalled = key => { try { return localStorage.getItem(key); } catch { return null; } };
const PENDING_KEY = 'ppm:update:pending';
const ACTIVE = new Set(['queued', 'preparing', 'downloading', 'countdown', 'stopping', 'backing_up', 'installing', 'restarting', 'verifying', 'committed', 'rolling_back']);

async function request(path, options) {
  const response = await apiFetch(`/system/updates${path}`, options);
  const payload = await response.json();
  if (!response.ok) throw Object.assign(new Error(apiErrorMessage(payload, '更新服务暂时不可用')), { status: response.status });
  return payload;
}

export function UpdateCenter({ version }) {
  const [info, setInfo] = useState(null), [job, setJob] = useState(null), [open, setOpen] = useState(false),
    [tip, setTip] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''),
    [offline, setOffline] = useState(false), [now, setNow] = useState(Date.now());
  const trigger = useRef(null), closeButton = useRef(null), requestKey = useRef(null), alive = useRef(true);
  const refresh = useCallback(async (force = false) => {
    const result = await request(force ? '/check' : '', force ? { method: 'POST' } : undefined);
    if (!alive.current) return;
    setInfo(result); setError('');
    if (result.latestJob) {
      setJob(result.latestJob);
      if (ACTIVE.has(result.latestJob.state)) remember(PENDING_KEY, result.latestJob.id);
    }
    const key = `ppm:update:seen:${result.installationId}:${result.latestVersion}`;
    const ignored = recalled(`ppm:update:ignored:${result.installationId}`) === result.latestVersion;
    if (result.hasUpdate && !result.warning && !ignored && Date.now() - Number(recalled(key) || 0) > 86400000) {
      setTip(true); remember(key, String(Date.now()));
    }
    return result;
  }, []);

  useEffect(() => {
    alive.current = true;
    refresh().catch(() => {});
    const timer = setInterval(() => refresh().catch(() => {}), 6 * 60 * 60 * 1000);
    const show = () => { setOpen(true); setTip(false); refresh().catch(reason => setError(reason.message)); };
    window.addEventListener('ppm:open-updates', show);
    return () => { alive.current = false; clearInterval(timer); window.removeEventListener('ppm:open-updates', show); };
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
    const escape = event => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    window.addEventListener('keydown', escape);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { window.removeEventListener('keydown', escape); clearInterval(timer); };
  }, [open]);

  const pendingId = job && ACTIVE.has(job.state) ? job.id : recalled(PENDING_KEY);
  useEffect(() => {
    if (!pendingId) return;
    let live = true, timer, failures = 0;
    async function poll() {
      try {
        const result = await request(`/jobs/${pendingId}`);
        if (!live) return;
        setOffline(false); failures = 0;
        if (result.terminal) {
          if (result.state === 'succeeded') {
            const response = await apiFetch('/runtime'), runtime = await response.json();
            if (!response.ok || runtime.appVersion !== result.targetVersion || runtime.buildInfo?.revision !== result.actualRevision) throw new Error('正在等待目标版本就绪');
            if (!live) return;
            remember(PENDING_KEY, '');
            const key = `ppm:update:reloaded:${result.id}`;
            if (!recalled(key)) { remember(key, '1'); window.location.reload(); return; }
          }
          remember(PENDING_KEY, ''); setJob(result);
          return;
        }
        setJob(result);
      } catch (reason) {
        if (!live) return;
        if ([401, 403, 404].includes(reason.status)) { setError(reason.message); return; }
        failures += 1; setOffline(true);
      }
      if (live) timer = setTimeout(poll, Math.min(10000, 2000 + failures * 1000));
    }
    poll();
    return () => { live = false; clearTimeout(timer); };
  }, [pendingId]);

  const working = Boolean(job && ACTIVE.has(job.state));
  async function begin() {
    setBusy(true); setError('');
    requestKey.current ||= crypto.randomUUID();
    try {
      const result = await request('/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestKey.current }, body: JSON.stringify({ version: info.latestVersion, digest: info.digest, autoRestart: true }) });
      remember(PENDING_KEY, result.id); setJob(result); setTip(false); requestKey.current = null;
    } catch (reason) { setError(reason.message); }
    finally { setBusy(false); }
  }
  const seconds = Math.max(0, Math.ceil(((job?.restartAt || 0) - now) / 1000));
  const currentVersion = info?.currentVersion || version;
  const versionLabel = currentVersion ? `v${currentVersion}` : '版本加载中';
  return <div className="update-center">
    <button ref={trigger} className={`update-version-button${info?.hasUpdate ? ' has-update' : ''}`} onClick={() => { setOpen(true); setTip(false); refresh().catch(reason => setError(reason.message)); }} aria-label={`版本更新，当前${versionLabel}`} aria-haspopup="dialog" aria-expanded={open} title={`${versionLabel} · ${working ? '正在更新' : info?.hasUpdate ? '发现新版本，点击查看' : '点击检查更新'}`}>
      <span className="update-version-copy"><span className="update-version-label"><strong>{versionLabel}</strong>{info?.hasUpdate && <i aria-label="发现新版本" />}</span><small>Proxy Port Manager</small></span>
      <span className="update-version-action" aria-hidden="true">{working ? '更新中' : info?.hasUpdate ? '↑' : '⋯'}</span>
    </button>
    {tip && !open && !working && <aside className="update-tip" role="status">
      <div><strong>发现新版本 v{info.latestVersion}</strong><p>查看更新内容，选择适合的时间更新。</p></div>
      <div className="update-tip-actions"><button className="button primary" onClick={() => { setOpen(true); setTip(false); }}>查看更新</button><button className="button ghost" onClick={() => setTip(false)}>稍后</button></div>
    </aside>}
    {job?.state === 'succeeded' && !open && recalled(`ppm:update:dismissed:${job.id}`) !== '1' && <aside className="update-tip success" role="status"><strong>{job.message}</strong><button className="text-button" onClick={() => { remember(`ppm:update:dismissed:${job.id}`, '1'); setJob(null); }}>知道了</button></aside>}
    {open && createPortal(<div className="modal-backdrop update-backdrop" onClick={event => { if (event.target === event.currentTarget) { setOpen(false); trigger.current?.focus(); } }}>
      <section className="update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-title" onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const controls = [...event.currentTarget.querySelectorAll('button:not(:disabled),a[href],input')], first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
        <header><div><span className="update-eyebrow">APPLICATION UPDATE</span><h2 id="update-title">版本更新</h2></div><button ref={closeButton} className="icon-button" aria-label="关闭更新窗口" onClick={() => { setOpen(false); trigger.current?.focus(); }}>×</button></header>
        <div className="update-dialog-body">
          <div className="update-version-row"><div><small>当前版本</small><strong>{versionLabel}</strong></div><span aria-hidden="true">→</span><div><small>{info?.hasUpdate ? '可用新版本' : '最新正式版本'}</small><strong>{info?.latestVersion ? `v${info.latestVersion}` : '暂未获取'}</strong></div></div>
          {info?.publishedAt && <p className="update-muted">发布于 {new Date(info.publishedAt).toLocaleDateString()}</p>}
          {!working && info?.notes && <details className="update-notes" open><summary>更新内容</summary><pre>{info.notes}</pre></details>}
          {info?.warning && <p className="update-warning" role="status">暂时无法检查更新：{info.warning}</p>}
          {!working && info?.unsupportedReason && info.hasUpdate && <p className="update-warning">{info.unsupportedReason}</p>}
          {!working && info?.hasUpdate && info.canUpdate && <p className="update-impact">更新前自动备份订阅、端口池、账号密钥和设置。安装时服务会短暂停止，代理连接可能中断；完成后自动重启并重新连接此页面。</p>}
          {job && <div className={`update-job ${job.state === 'succeeded' ? 'success' : ''}`} aria-live="polite">
            <strong>{offline ? '服务正在重启或暂时无法连接，正在等待恢复…' : job.message}</strong>
            {job.state === 'countdown' && <p>{seconds > 0 ? `${seconds} 秒后开始备份并自动重启服务` : '即将开始备份并重启…'}</p>}
            {Number.isFinite(job.progress) && <><progress max="100" value={job.progress} aria-label="下载进度" /><span>{job.progress}%</span></>}
            {job.error && <p className="update-warning">{job.error}</p>}
            {offline && <p className="update-muted">关闭窗口不会取消更新。长时间未恢复时，请查看本机更新日志，或使用恢复命令。</p>}
            {job.state === 'recovery_required' && <p>便携版运行 ppm recover-update；Docker 按升级文档执行 updater 恢复命令。</p>}
          </div>}
          {error && <p className="update-warning" role="alert">{error}</p>}
          {info && <label className="update-preference"><input type="checkbox" checked={info.automatic} disabled={busy || working} onChange={async event => {
            try { const automatic = event.target.checked; await request('/preferences', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ automatic }) }); setInfo(current => ({ ...current, automatic })); } catch (reason) { setError(reason.message); }
          }} />自动检查新版本（不会自动安装）</label>}
        </div>
        <footer>
          <button className="button ghost" disabled={busy || working} onClick={async () => { setBusy(true); try { await refresh(true); } catch (reason) { setError(reason.message); } finally { setBusy(false); } }}>检查更新</button>
          {info?.releaseUrl && <a className="text-button" href={info.releaseUrl} target="_blank" rel="noreferrer">发布说明 ↗</a>}
          {info?.hasUpdate && !working && <button className="text-button" onClick={() => { remember(`ppm:update:ignored:${info.installationId}`, info.latestVersion); setTip(false); setOpen(false); }}>忽略此版本</button>}
          {working ? job.canCancel && <button className="button ghost" disabled={offline || (job.state === 'countdown' && seconds === 0)} onClick={() => request(`/jobs/${job.id}/cancel`, { method: 'POST' }).catch(reason => setError(reason.message))}>取消更新</button> : info?.canUpdate && <button className="button primary" disabled={busy || job?.state === 'recovery_required'} onClick={begin}>{busy ? '正在提交…' : '更新并自动重启'}</button>}
        </footer>
      </section>
    </div>, document.body)}
  </div>;
}
