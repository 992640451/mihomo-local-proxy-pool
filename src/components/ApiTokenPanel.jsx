import { useEffect, useState } from 'react';
import { API_SCOPES } from '../../shared/apiScopes.js';
import { apiErrorMessage, apiFetch } from '../api.js';

const date = value => value ? new Date(value).toLocaleString() : '尚未使用';

export function ApiTokenPanel() {
  const [tokens, setTokens] = useState([]), [name, setName] = useState(''), [days, setDays] = useState(90),
    [scopes, setScopes] = useState(['read']), [secret, setSecret] = useState(''), [busy, setBusy] = useState(false),
    [error, setError] = useState(''), [message, setMessage] = useState(''), [pendingRevoke, setPendingRevoke] = useState(null);
  const load = async () => {
    const response = await apiFetch('/tokens'), result = await response.json();
    if (!response.ok) throw new Error(apiErrorMessage(result, '令牌列表读取失败'));
    setTokens(result.tokens);
  };
  useEffect(() => { load().catch(reason => setError(reason.message)); }, []);
  const create = async event => {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try {
      const response = await apiFetch('/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, scopes, expiresInDays: days }) });
      const result = await response.json();
      if (!response.ok) throw new Error(apiErrorMessage(result, '创建令牌失败'));
      setSecret(result.secret); setName(''); await load();
    } catch (reason) { setError(reason.message); }
    finally { setBusy(false); }
  };
  const revoke = async token => {
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await apiFetch(`/tokens/${encodeURIComponent(token.id)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(apiErrorMessage(await response.json(), '撤销令牌失败'));
      await load(); setPendingRevoke(null); setMessage('令牌已撤销。');
    } catch (reason) { setError(reason.message); }
    finally { setBusy(false); }
  };
  return <section className="data-card reliability-card automation-card">
    <div className="reliability-head"><div><span className="eyebrow">AUTOMATION API</span><h2>API 令牌</h2><p>供 CLI 和脚本使用；密钥只显示一次，服务端仅保存摘要。<a href="api/v1/openapi.json" target="_blank" rel="noreferrer">查看 OpenAPI 合同</a></p></div></div>
    <p className="automation-note">管理权限包含只读。配置导出与恢复会访问节点凭据，必须同时授予订阅管理和端口管理。令牌不可管理其他令牌，也不包含在配置备份中。</p>
    {(error || message) && <p role="status" className={error ? 'subscription-error' : 'subscription-preview'}>{error || message}</p>}
    {secret && <div className="automation-secret" role="status"><strong>请立即保存；关闭后无法再次查看</strong><label><span>新令牌密钥</span><textarea readOnly spellCheck={false} value={secret} rows={2} /></label><button className="button ghost" onClick={() => { setSecret(''); setMessage('密钥已从界面清除。遗失时请撤销并重新创建。'); }}>我已保存，清除显示</button></div>}
    <form className="recovery-form" onSubmit={create}>
      <div className="automation-inputs"><label><span>令牌名称</span><input value={name} maxLength={80} required placeholder="例如：CI 每日备份" onChange={event => setName(event.target.value)} /></label><label><span>有效期（天）</span><input type="number" value={days} min={1} max={365} required onChange={event => setDays(Number(event.target.value))} /></label></div>
      <fieldset className="automation-scopes"><legend>访问权限</legend>{Object.entries(API_SCOPES).map(([key, label]) => <label key={key}><input type="checkbox" checked={scopes.includes(key)} disabled={key === 'read'} onChange={event => setScopes(current => event.target.checked ? [...current, key] : current.filter(scope => scope !== key))} /><span>{label}</span></label>)}</fieldset>
      <button className="button primary" disabled={busy || !!secret || !name.trim()} type="submit">{busy ? '处理中…' : '创建令牌'}</button>
    </form>
    <div className="automation-token-list">{tokens.length === 0 && <p>暂无 API 令牌。</p>}{tokens.map(token => {
      const inactive = !!token.revokedAt || token.expiresAt <= Date.now();
      return <article className="automation-token" key={token.id}><div><strong>{token.name}</strong><small>{token.scopes.join(' · ')}</small><small>最近使用：{date(token.lastUsedAt)} · 到期：{date(token.expiresAt)}</small><small>{token.revokedAt ? '已撤销' : inactive ? '已过期' : '有效'}</small></div><button className="button danger" disabled={busy || inactive} onClick={() => setPendingRevoke(token.id)}>撤销</button>
        {pendingRevoke === token.id && <div className="automation-revoke" role="alert"><p>撤销后，新请求将失去访问权限；在途操作不会取消。确认撤销“{token.name}”？</p><div className="page-actions"><button className="button ghost" disabled={busy} onClick={() => setPendingRevoke(null)}>取消</button><button className="button danger" disabled={busy} onClick={() => revoke(token)}>确认撤销</button></div></div>}
      </article>;
    })}</div>
  </section>;
}
