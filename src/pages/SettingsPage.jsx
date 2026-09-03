import { useState } from "react";
import { RECOVERY_MAX_FILE_BYTES } from "../../shared/recoveryLimits.js";
import { apiErrorMessage, apiFetch } from "../api.js";
import { PageHead, Select, formatDuration } from "../components/ui.jsx";
import { ApiTokenPanel } from "../components/ApiTokenPanel.jsx";

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob), anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
}

function datedName(prefix) { return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`; }

const CHECK_LABELS = {
  subscriptionDatabase: "订阅数据库", sessionDatabase: "会话数据库", auditDatabase: "审计数据库",
  observationDatabase: "检测历史数据库", observationScheduler: "后台检测调度器",
  apiTokenDatabase: "API 令牌数据库",
  subscriptionScheduler: "订阅调度器", mihomoCore: "Mihomo 核心", catalog: "配置目录", storage: "数据存储",
};

export function SettingsPage({ runtime, refreshSeconds, setRefreshSeconds, resetPorts, refresh, onRecovered }) {
  const [diagnostics, setDiagnostics] = useState(null), [diagnosticBusy, setDiagnosticBusy] = useState(false),
    [backupBusy, setBackupBusy] = useState(false), [restoreBusy, setRestoreBusy] = useState(false),
    [exportPassword, setExportPassword] = useState(""), [exportConfirmation, setExportConfirmation] = useState(""),
    [restorePassword, setRestorePassword] = useState(""), [restoreFile, setRestoreFile] = useState(null),
    [restoreSummary, setRestoreSummary] = useState(null), [message, setMessage] = useState(""), [error, setError] = useState("");

  const runDiagnostics = async () => {
    setDiagnosticBusy(true); setError(""); setMessage("");
    try {
      const response = await apiFetch("/diagnostics"), payload = await response.json();
      if (!response.ok) throw new Error(apiErrorMessage(payload, "系统诊断失败"));
      setDiagnostics(payload);
    } catch (reason) { setError(reason.message); }
    finally { setDiagnosticBusy(false); }
  };
  const exportDiagnostics = async () => {
    setDiagnosticBusy(true); setError("");
    try {
      const response = await apiFetch("/diagnostics/export");
      if (!response.ok) throw new Error(apiErrorMessage(await response.json(), "诊断数据导出失败"));
      downloadBlob(await response.blob(), datedName("ppm-diagnostics")); setMessage("已下载脱敏诊断文件。");
    } catch (reason) { setError(reason.message); }
    finally { setDiagnosticBusy(false); }
  };
  const exportRecovery = async () => {
    setError(""); setMessage("");
    if (exportPassword.length < 8) return setError("恢复包口令至少需要 8 个字符。");
    if (exportPassword !== exportConfirmation) return setError("两次输入的恢复包口令不一致。");
    setBackupBusy(true);
    try {
      const response = await apiFetch("/config/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: exportPassword }) });
      if (!response.ok) throw new Error(apiErrorMessage(await response.json(), "恢复包创建失败"));
      downloadBlob(await response.blob(), datedName("ppm-recovery"));
      setExportPassword(""); setExportConfirmation(""); setMessage("加密恢复包已下载，请把文件和口令分开保存。");
    } catch (reason) { setError(reason.message); }
    finally { setBackupBusy(false); }
  };
  const readRecoveryPackage = async () => {
    if (!restoreFile) throw new Error("请先选择恢复包文件。");
    if (restoreFile.size > RECOVERY_MAX_FILE_BYTES) throw new Error("恢复包文件超过 33 MiB 上限。");
    try { return JSON.parse(await restoreFile.text()); } catch { throw new Error("恢复包不是有效的 JSON 文件。"); }
  };
  const inspectRecovery = async () => {
    setRestoreBusy(true); setError(""); setMessage(""); setRestoreSummary(null);
    try {
      const recoveryPackage = await readRecoveryPackage();
      const response = await apiFetch("/config/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ recoveryPackage, password: restorePassword }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(apiErrorMessage(payload, "恢复包校验失败"));
      setRestoreSummary(payload); setMessage(payload.canApply ? "预检完成。请核对增改删明细；计划 10 分钟内有效，配置变化后必须重新预检。" : "预检发现阻塞问题，不能应用此恢复包。");
    } catch (reason) { setError(reason.message); }
    finally { setRestoreBusy(false); }
  };
  const restoreRecovery = async () => {
    if (!restoreSummary?.canApply) return setError("请先完成恢复包预检。");
    if (!window.confirm(`恢复将替换当前配置为恢复包中的 ${restoreSummary.subscriptions} 个订阅和 ${restoreSummary.ports} 个端口。未包含的资源将删除。是否继续？`)) return;
    setRestoreBusy(true); setError(""); setMessage("");
    try {
      const recoveryPackage = await readRecoveryPackage();
      const response = await apiFetch("/config/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ recoveryPackage, password: restorePassword, planToken: restoreSummary.planToken }) });
      const payload = await response.json();
      if (!response.ok) { setRestoreSummary(null); throw new Error(apiErrorMessage(payload, "恢复失败")); }
      setRestoreSummary(null); setRestoreFile(null); setRestorePassword(""); await onRecovered?.();
      setMessage(`恢复完成：${payload.subscriptions} 个订阅、${payload.ports} 个端口。`);
    } catch (reason) { setError(reason.message); }
    finally { setRestoreBusy(false); }
  };

  return <div className="page-stack automation-page">
    <PageHead eyebrow="SYSTEM SETTINGS" title="系统设置" description="管理版本更新、运行诊断、自动化权限和加密备份恢复。" />
    <section className="data-card update-settings-entry"><div><strong>版本更新</strong><p>当前 v{runtime.appVersion || 'unknown'} · 查看新版本，主动更新并自动重启服务。</p></div><button className="button primary" onClick={() => window.dispatchEvent(new Event('ppm:open-updates'))}>查看版本更新</button></section>
    {(error || message) && <div className={error ? "subscription-error" : "subscription-preview reliability-message"}>{error || message}</div>}
    <section className="data-card settings-card">
      <label className="setting-row"><span><strong>界面数据自动刷新</strong><small>仅刷新管理界面；订阅的服务端刷新周期在订阅页单独设置</small></span><Select value={String(refreshSeconds)} onChange={(value) => setRefreshSeconds(Number(value))}><option value="0">关闭</option><option value="30">30 秒</option><option value="60">1 分钟</option><option value="300">5 分钟</option></Select></label>
      <div className="setting-row"><span><strong>立即刷新界面</strong><small>重新读取订阅、端口配置与 Mihomo 运行状态</small></span><button className="button primary" onClick={refresh}>读取状态</button></div>
      <div className="setting-row"><span><strong>重新同步端口配置</strong><small>丢弃当前界面状态并重新读取服务端端口配置</small></span><button className="button danger" onClick={resetPorts}>重新同步</button></div>
    </section>
    <section className="data-card reliability-card"><div className="reliability-head"><div><span className="eyebrow">DIAGNOSTICS</span><h2>系统诊断</h2><p>检查数据库、订阅调度器、Mihomo、端口配置和数据目录。</p></div><div className="page-actions"><button className="button ghost" disabled={diagnosticBusy} onClick={runDiagnostics}>{diagnosticBusy ? "检查中…" : "运行诊断"}</button><button className="button primary" disabled={diagnosticBusy} onClick={exportDiagnostics}>导出脱敏诊断</button></div></div>
      {diagnostics && <div className="diagnostic-list">{diagnostics.checks.map((check) => <div className={`diagnostic-row ${check.status}`} key={check.name}><span className="status-dot" /><strong>{CHECK_LABELS[check.name] || check.name}</strong><small>{check.message || (check.status === "ok" ? "检查通过" : "需要关注")}</small><code>{check.durationMs} ms</code></div>)}</div>}
    </section>
    <ApiTokenPanel />
    <section className="data-card reliability-card"><div className="reliability-head"><div><span className="eyebrow">ENCRYPTED BACKUP</span><h2>备份当前配置</h2><p>恢复包包含订阅、节点凭据和端口池，使用口令加密；不包含登录会话、API 令牌、审计日志或检测历史与调度设置。</p></div></div><div className="recovery-form two-columns">
      <label><span>恢复包口令</span><input type="password" autoComplete="new-password" value={exportPassword} onChange={(event) => setExportPassword(event.target.value)} /></label><label><span>确认口令</span><input type="password" autoComplete="new-password" value={exportConfirmation} onChange={(event) => setExportConfirmation(event.target.value)} /></label><button className="button primary" disabled={backupBusy} onClick={exportRecovery}>{backupBusy ? "正在加密…" : "下载加密恢复包"}</button>
    </div></section>
    <section className="data-card reliability-card danger-zone"><div className="reliability-head"><div><span className="eyebrow">RESTORE</span><h2>恢复配置</h2><p>恢复前会完整校验文件；应用失败时自动恢复当前订阅和端口配置。</p></div></div><div className="recovery-form">
      <label><span>恢复包文件</span><input type="file" accept="application/json,.json" onChange={(event) => { setRestoreFile(event.target.files?.[0] || null); setRestoreSummary(null); }} /></label><label><span>恢复包口令</span><input type="password" autoComplete="current-password" value={restorePassword} onChange={(event) => { setRestorePassword(event.target.value); setRestoreSummary(null); }} /></label>
      {restoreSummary && <div className="recovery-summary"><p>版本 {restoreSummary.appVersion} · {restoreSummary.subscriptions} 个订阅 · {restoreSummary.nodes} 个节点 · {restoreSummary.ports} 个端口</p>
        {Object.entries(restoreSummary.changes).map(([kind, change]) => <details key={kind}><summary>{{ subscriptions: '订阅', nodes: '节点', ports: '端口' }[kind]}：新增 {change.added.length} / 修改 {change.modified.length} / 删除 {change.deleted.length} / 不变 {change.unchanged}</summary>{['added', 'modified', 'deleted'].map(action => <p className="automation-diff" key={action}>{{ added: '新增', modified: '修改', deleted: '删除' }[action]} ID：{change[action].slice(0, 100).join(', ') || '无'}{change[action].length > 100 ? '（界面仅显示前 100 项，完整列表请使用 CLI）' : ''}</p>)}</details>)}
        {restoreSummary.missingNodes.map(item => <p key={item.port}>阻塞：端口 {item.port} 引用缺失节点 {item.nodeIds.join(', ')}</p>)}
        {restoreSummary.unavailableNodes.map(item => <p key={item.port}>提醒：端口 {item.port} 引用已停用订阅或孤立节点 {item.nodeIds.join(', ')}</p>)}
        {restoreSummary.errors.map((item, index) => <p key={index}>{item}</p>)}
      </div>}<div className="page-actions"><button className="button ghost" disabled={restoreBusy} onClick={inspectRecovery}>{restoreBusy ? "处理中…" : "预检恢复变更"}</button><button className="button danger" disabled={restoreBusy || !restoreSummary?.canApply} onClick={restoreRecovery}>替换并恢复</button></div>
    </div></section>
    <section className="data-card"><h2>运行环境</h2><dl className="detail-list">
      <div><dt>应用版本</dt><dd>{runtime.appVersion || "unknown"}</dd></div>
      <div><dt>构建提交</dt><dd title={runtime.buildInfo?.revision || ""}>{runtime.buildInfo?.revision?.slice(0, 12) || "未注入（本地构建）"}</dd></div>
      <div><dt>构建时间（UTC）</dt><dd>{runtime.buildInfo?.builtAt || "未注入"}</dd></div>
      <div><dt>构建目标</dt><dd>{runtime.buildInfo?.target || "source"}</dd></div>
      <div><dt>Node.js</dt><dd>{runtime.buildInfo?.nodeVersion || "unknown"}</dd></div>
      <div><dt>Mihomo</dt><dd>{runtime.core?.version || "不可用"}</dd></div>
      <div><dt>主机</dt><dd>{runtime.hostname}</dd></div><div><dt>平台</dt><dd>{runtime.platform}</dd></div><div><dt>服务进程运行时长</dt><dd>{formatDuration(runtime.processUptimeSeconds)}</dd></div><div><dt>系统运行时长</dt><dd>{formatDuration(runtime.systemUptimeSeconds)}</dd></div>
    </dl></section>
  </div>;
}
