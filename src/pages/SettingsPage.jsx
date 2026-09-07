import { useEffect, useState } from "react";
import { RECOVERY_MAX_FILE_BYTES } from "../../shared/recoveryLimits.js";
import { apiErrorMessage, apiFetch } from "../api.js";
import { Icon, PageHead, Select, formatDuration } from "../components/ui.jsx";
import { ApiTokenPanel } from "../components/ApiTokenPanel.jsx";

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob), anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
}

function datedName(prefix) { return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`; }

const CHECK_LABELS = {
  subscriptionDatabase: "订阅数据库", sessionDatabase: "会话数据库", auditDatabase: "审计数据库",
  observationDatabase: "检测历史数据库", observationScheduler: "后台检测调度器",
  apiTokenDatabase: "API 令牌数据库", subscriptionScheduler: "订阅调度器", mihomoCore: "Mihomo 核心",
  catalog: "配置目录", storage: "数据存储",
};

const SETTINGS_SECTIONS = [
  { id: "general", label: "常规设置", description: "界面行为", icon: "settings" },
  { id: "browser", label: "浏览器接入", description: "Roxy 与普通浏览器", icon: "grid" },
  { id: "automation", label: "自动化 API", description: "令牌与接口", icon: "clipboard" },
  { id: "recovery", label: "备份与恢复", description: "配置迁移与恢复", icon: "file" },
  { id: "system", label: "系统与诊断", description: "版本、健康与环境", icon: "activity" },
];

function SettingsSectionHeader({ eyebrow, title, description, action }) {
  return <header className="settings-section-head">
    <div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2><p>{description}</p></div>
    {action}
  </header>;
}

function GeneralSettings({ refreshSeconds, setRefreshSeconds }) {
  return <section className="data-card settings-section-card">
    <SettingsSectionHeader eyebrow="GENERAL" title="常规设置" description="调整当前管理界面的显示和刷新方式。" />
    <div className="setting-row">
      <span><strong>界面数据自动刷新</strong><small>仅刷新管理界面；订阅的服务端刷新周期在订阅页单独设置。</small></span>
      <Select value={String(refreshSeconds)} onChange={(value) => setRefreshSeconds(Number(value))} ariaLabel="界面数据自动刷新周期">
        <option value="0">关闭</option><option value="30">30 秒</option><option value="60">1 分钟</option><option value="300">5 分钟</option>
      </Select>
    </div>
    <p className="settings-section-note">需要立即更新数据时，请使用页面右上角的刷新按钮。</p>
  </section>;
}

function BrowserIntegrationSettings() {
  const [config, setConfig] = useState(null), [apiPort, setApiPort] = useState(50000), [apiKey, setApiKey] = useState(''),
    [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    apiFetch('/browser/roxy/config', { signal: controller.signal }).then(async response => {
      const payload = await response.json()
      if (!response.ok) throw new Error(apiErrorMessage(payload, 'Roxy 配置读取失败'))
      setConfig(payload); setApiPort(payload.apiPort || 50000)
    }).catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
    return () => controller.abort()
  }, [])
  const connect = async event => {
    event.preventDefault(); setBusy(true); setError(''); setMessage('')
    try {
      const response = await apiFetch('/browser/roxy/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiPort: Number(apiPort), ...(apiKey ? { apiKey } : {}) }) })
      const payload = await response.json()
      if (!response.ok) throw new Error(apiErrorMessage(payload, 'Roxy 连接失败'))
      setConfig(payload.config); setApiKey(''); setMessage(`连接成功，已读取 ${payload.workspaces?.length || 0} 个团队/项目。`)
    } catch (reason) { setError(reason.message) }
    finally { setBusy(false) }
  }
  return <section className="data-card settings-section-card">
    <SettingsSectionHeader eyebrow="BROWSER INTEGRATIONS" title="浏览器接入" description="集中管理浏览器连接；端口与浏览器窗口的绑定仍在代理端口页完成。" />
    <div className="browser-integration-grid">
      <article className="browser-integration-card">
        <div className="browser-integration-title"><div><strong>Roxy Browser</strong><small>本地 API 与窗口发现</small></div><span className={`settings-status ${config?.configured ? 'connected' : 'pending'}`}>{config?.configured ? '已配置' : '尚未配置'}</span></div>
        <form className="roxy-connect-form" onSubmit={connect}>
          <label><span>API 端口</span><input type="number" min="1" max="65535" value={apiPort} onChange={event => setApiPort(event.target.value)} required /></label>
          <label><span>API Key</span><input type="password" autoComplete="off" value={apiKey} placeholder={config?.hasApiKey ? '已保存；留空表示不修改' : '粘贴 Roxy API Key'} onChange={event => setApiKey(event.target.value)} required={!config?.hasApiKey} /></label>
          <button className="button primary" disabled={busy}>{busy ? '正在连接…' : config?.configured ? '重新测试并保存' : '测试并连接'}</button>
        </form>
        {(error || message) && <p className={error ? 'browser-integration-error' : 'browser-integration-success'}>{error || message}</p>}
        {!error && !message && <p>连接后，团队、项目和窗口会在代理端口配置中自动读取，无需手动查找 ID。</p>}
      </article>
      <article className="browser-integration-card">
        <div className="browser-integration-title"><div><strong>普通浏览器</strong><small>Chrome、Edge 等独立配置</small></div><span className="settings-status pending">尚未接入</span></div>
        <p>普通浏览器将通过本机启动助手管理独立用户目录和运行状态。</p>
      </article>
    </div>
    <p className="settings-section-note">连接 Roxy 后，请到“代理端口”编辑会话轮换端口，选择团队、项目和窗口；保存后即可从端口卡片一键启动。</p>
  </section>;
}

function DataRecoverySettings({
  backupOpen, setBackupOpen, restoreOpen, setRestoreOpen,
  exportPassword, setExportPassword, exportConfirmation, setExportConfirmation, backupBusy, exportRecovery,
  restoreFile, setRestoreFile, restorePassword, setRestorePassword, restoreSummary, setRestoreSummary,
  restoreBusy, inspectRecovery, restoreRecovery,
}) {
  return <div className="settings-panel-stack">
    <section className="data-card settings-section-card">
      <SettingsSectionHeader eyebrow="DATA SAFETY" title="备份与恢复" description="备份用于迁移和灾难恢复；恢复会先显示完整变更预检。" />
      <div className="recovery-action-grid">
        <article className={`recovery-action-card${backupOpen ? " open" : ""}`}>
          <div><strong>备份当前配置</strong><p>加密导出订阅、节点凭据和端口池。</p></div>
          <button className="button primary" type="button" onClick={() => setBackupOpen(value => !value)} aria-expanded={backupOpen}>{backupOpen ? "收起" : "创建备份"}</button>
        </article>
        <article className={`recovery-action-card danger${restoreOpen ? " open" : ""}`}>
          <div><strong>恢复配置</strong><p>预检后替换当前订阅和端口配置。</p></div>
          <button className="button danger" type="button" onClick={() => setRestoreOpen(value => !value)} aria-expanded={restoreOpen}>{restoreOpen ? "收起" : "开始恢复"}</button>
        </article>
      </div>
    </section>
    {backupOpen && <section className="data-card reliability-card settings-detail-card">
      <SettingsSectionHeader title="创建加密备份" description="恢复包不包含登录会话、API 令牌、审计日志、检测历史或调度设置。" />
      <div className="recovery-form two-columns">
        <label><span>恢复包口令</span><input type="password" autoComplete="new-password" value={exportPassword} onChange={(event) => setExportPassword(event.target.value)} /></label>
        <label><span>确认口令</span><input type="password" autoComplete="new-password" value={exportConfirmation} onChange={(event) => setExportConfirmation(event.target.value)} /></label>
        <button className="button primary" disabled={backupBusy} onClick={exportRecovery}>{backupBusy ? "正在加密…" : "下载加密恢复包"}</button>
      </div>
    </section>}
    {restoreOpen && <section className="data-card reliability-card danger-zone settings-detail-card">
      <SettingsSectionHeader title="恢复配置" description="恢复前会完整校验文件；应用失败时自动恢复当前配置。" />
      <div className="recovery-form">
        <label><span>恢复包文件</span><input type="file" accept="application/json,.json" onChange={(event) => { setRestoreFile(event.target.files?.[0] || null); setRestoreSummary(null); }} /></label>
        <label><span>恢复包口令</span><input type="password" autoComplete="current-password" value={restorePassword} onChange={(event) => { setRestorePassword(event.target.value); setRestoreSummary(null); }} /></label>
        {restoreSummary && <div className="recovery-summary"><p>版本 {restoreSummary.appVersion} · {restoreSummary.subscriptions} 个订阅 · {restoreSummary.nodes} 个节点 · {restoreSummary.ports} 个端口</p>
          {Object.entries(restoreSummary.changes).map(([kind, change]) => <details key={kind}><summary>{{ subscriptions: '订阅', nodes: '节点', ports: '端口' }[kind]}：新增 {change.added.length} / 修改 {change.modified.length} / 删除 {change.deleted.length} / 不变 {change.unchanged}</summary>{['added', 'modified', 'deleted'].map(action => <p className="automation-diff" key={action}>{{ added: '新增', modified: '修改', deleted: '删除' }[action]} ID：{change[action].slice(0, 100).join(', ') || '无'}{change[action].length > 100 ? '（界面仅显示前 100 项，完整列表请使用 CLI）' : ''}</p>)}</details>)}
          {restoreSummary.missingNodes.map(item => <p key={item.port}>阻塞：端口 {item.port} 引用缺失节点 {item.nodeIds.join(', ')}</p>)}
          {restoreSummary.unavailableNodes.map(item => <p key={item.port}>提醒：端口 {item.port} 引用已停用订阅或孤立节点 {item.nodeIds.join(', ')}</p>)}
          {restoreSummary.errors.map((item, index) => <p key={index}>{item}</p>)}
        </div>}
        <div className="page-actions"><button className="button ghost" disabled={restoreBusy} onClick={inspectRecovery}>{restoreBusy ? "处理中…" : "预检恢复变更"}</button><button className="button danger" disabled={restoreBusy || !restoreSummary?.canApply} onClick={restoreRecovery}>替换并恢复</button></div>
      </div>
    </section>}
  </div>;
}

function SystemDiagnosticsSettings({ runtime, diagnostics, diagnosticBusy, runDiagnostics, exportDiagnostics }) {
  return <div className="settings-panel-stack">
    <section className="data-card settings-section-card">
      <SettingsSectionHeader eyebrow="SYSTEM STATUS" title="系统与诊断" description="集中查看版本、核心状态和运行环境，并在出现问题时执行诊断。" action={<button className="button primary" onClick={() => window.dispatchEvent(new Event('ppm:open-updates'))}>查看版本更新</button>} />
      <div className="system-summary-grid">
        <div><span>应用版本</span><strong>v{runtime.appVersion || "unknown"}</strong></div>
        <div><span>Mihomo 核心</span><strong>{runtime.core?.version || "不可用"}</strong></div>
        <div><span>服务运行</span><strong>{formatDuration(runtime.processUptimeSeconds)}</strong></div>
      </div>
    </section>
    <section className="data-card reliability-card settings-detail-card">
      <SettingsSectionHeader title="系统诊断" description="检查数据库、订阅调度器、Mihomo、端口配置和数据目录。" action={<div className="page-actions"><button className="button ghost" disabled={diagnosticBusy} onClick={runDiagnostics}>{diagnosticBusy ? "检查中…" : "运行诊断"}</button><button className="button primary" disabled={diagnosticBusy} onClick={exportDiagnostics}>导出脱敏诊断</button></div>} />
      {diagnostics ? <div className="diagnostic-list">{diagnostics.checks.map((check) => <div className={`diagnostic-row ${check.status}`} key={check.name}><span className="status-dot" /><strong>{CHECK_LABELS[check.name] || check.name}</strong><small>{check.message || (check.status === "ok" ? "检查通过" : "需要关注")}</small><code>{check.durationMs} ms</code></div>)}</div> : <p className="settings-empty-result">需要排查问题时运行诊断，结果会显示在这里。</p>}
    </section>
    <details className="data-card runtime-details">
      <summary>查看完整运行环境</summary>
      <dl className="detail-list">
        <div><dt>应用版本</dt><dd>{runtime.appVersion || "unknown"}</dd></div>
        <div><dt>构建提交</dt><dd title={runtime.buildInfo?.revision || ""}>{runtime.buildInfo?.revision?.slice(0, 12) || "未注入（本地构建）"}</dd></div>
        <div><dt>构建时间（UTC）</dt><dd>{runtime.buildInfo?.builtAt || "未注入"}</dd></div>
        <div><dt>构建目标</dt><dd>{runtime.buildInfo?.target || "source"}</dd></div>
        <div><dt>Node.js</dt><dd>{runtime.buildInfo?.nodeVersion || "unknown"}</dd></div>
        <div><dt>Mihomo</dt><dd>{runtime.core?.version || "不可用"}</dd></div>
        <div><dt>主机</dt><dd>{runtime.hostname}</dd></div><div><dt>平台</dt><dd>{runtime.platform}</dd></div>
        <div><dt>服务进程运行时长</dt><dd>{formatDuration(runtime.processUptimeSeconds)}</dd></div><div><dt>系统运行时长</dt><dd>{formatDuration(runtime.systemUptimeSeconds)}</dd></div>
      </dl>
    </details>
  </div>;
}

export function SettingsPage({ runtime, refreshSeconds, setRefreshSeconds, onRecovered }) {
  const [activeSection, setActiveSectionState] = useState(() => {
      const saved = localStorage.getItem("ppm:settingsSection");
      return SETTINGS_SECTIONS.some(section => section.id === saved) ? saved : "general";
    }),
    [diagnostics, setDiagnostics] = useState(null), [diagnosticBusy, setDiagnosticBusy] = useState(false),
    [backupOpen, setBackupOpen] = useState(false), [restoreOpen, setRestoreOpen] = useState(false),
    [backupBusy, setBackupBusy] = useState(false), [restoreBusy, setRestoreBusy] = useState(false),
    [exportPassword, setExportPassword] = useState(""), [exportConfirmation, setExportConfirmation] = useState(""),
    [restorePassword, setRestorePassword] = useState(""), [restoreFile, setRestoreFile] = useState(null),
    [restoreSummary, setRestoreSummary] = useState(null), [message, setMessage] = useState(""), [error, setError] = useState("");

  const setActiveSection = value => {
    setActiveSectionState(value); localStorage.setItem("ppm:settingsSection", value); setError(""); setMessage("");
  };
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

  const recoveryProps = { backupOpen, setBackupOpen, restoreOpen, setRestoreOpen, exportPassword, setExportPassword, exportConfirmation, setExportConfirmation, backupBusy, exportRecovery, restoreFile, setRestoreFile, restorePassword, setRestorePassword, restoreSummary, setRestoreSummary, restoreBusy, inspectRecovery, restoreRecovery };
  return <div className="page-stack automation-page settings-page">
    <PageHead eyebrow="SYSTEM SETTINGS" title="系统设置" description="按用途管理界面、浏览器接入、自动化、数据安全和系统维护。" />
    <div className="settings-mobile-nav"><span>设置分类</span><Select value={activeSection} onChange={setActiveSection} ariaLabel="选择设置分类">{SETTINGS_SECTIONS.map(section => <option key={section.id} value={section.id}>{section.label}</option>)}</Select></div>
    <div className="settings-center">
      <nav className="settings-section-nav" aria-label="设置分类">{SETTINGS_SECTIONS.map(section => <button id={`settings-tab-${section.id}`} type="button" key={section.id} className={activeSection === section.id ? "active" : ""} aria-current={activeSection === section.id ? "page" : undefined} onClick={() => setActiveSection(section.id)}><Icon name={section.icon} /><span><strong>{section.label}</strong><small>{section.description}</small></span></button>)}</nav>
      <section className="settings-content" aria-labelledby={`settings-tab-${activeSection}`}>
        {(error || message) && <div role="status" className={error ? "subscription-error" : "subscription-preview reliability-message"}>{error || message}</div>}
        {activeSection === "general" && <GeneralSettings refreshSeconds={refreshSeconds} setRefreshSeconds={setRefreshSeconds} />}
        {activeSection === "browser" && <BrowserIntegrationSettings />}
        {activeSection === "automation" && <ApiTokenPanel />}
        {activeSection === "recovery" && <DataRecoverySettings {...recoveryProps} />}
        {activeSection === "system" && <SystemDiagnosticsSettings runtime={runtime} diagnostics={diagnostics} diagnosticBusy={diagnosticBusy} runDiagnostics={runDiagnostics} exportDiagnostics={exportDiagnostics} />}
      </section>
    </div>
  </div>;
}
