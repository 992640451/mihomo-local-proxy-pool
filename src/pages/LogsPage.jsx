import { useCallback, useEffect, useState } from "react";
import { apiErrorMessage, apiFetch } from "../api.js";
import { PageHead, Select } from "../components/ui.jsx";

const ACTION_LABELS = {
  "auth.login": "登录", "auth.logout": "退出", "subscription.create": "导入订阅",
  "subscription.update": "更新订阅", "subscription.refresh": "刷新订阅",
  "subscription.refreshAll": "批量刷新", "subscription.delete": "删除订阅",
  "port.apply": "应用端口", "port.delete": "删除端口", "port.verify": "验证端口",
  "recovery.export": "创建备份", "recovery.restore": "恢复备份",
  "diagnostics.export": "导出诊断", "audit.clear": "清理记录",
};

export function LogsPage() {
  const [events, setEvents] = useState([]),
    [outcome, setOutcome] = useState("all"),
    [nextBefore, setNextBefore] = useState(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");

  const load = useCallback(async ({ append = false, before = null } = {}) => {
    setLoading(true); setError("");
    try {
      const query = new URLSearchParams({ limit: "100" });
      if (outcome !== "all") query.set("outcome", outcome);
      if (before) query.set("before", String(before));
      const response = await apiFetch(`/audit?${query}`), payload = await response.json();
      if (!response.ok) throw new Error(apiErrorMessage(payload, "操作记录读取失败"));
      setEvents((current) => append ? [...current, ...payload.events] : payload.events);
      setNextBefore(payload.nextBefore || null);
    } catch (reason) { setError(reason.message); }
    finally { setLoading(false); }
  }, [outcome]);

  useEffect(() => { load(); }, [load]);

  const clear = async () => {
    if (!window.confirm("确定清理服务端操作记录吗？清理动作本身仍会保留一条记录。")) return;
    setLoading(true);
    try {
      const response = await apiFetch("/audit", { method: "DELETE" }), payload = await response.json();
      if (!response.ok) throw new Error(apiErrorMessage(payload, "操作记录清理失败"));
      await load();
    } catch (reason) { setError(reason.message); setLoading(false); }
  };

  return (
    <div className="page-stack">
      <PageHead eyebrow="SERVER AUDIT" title="操作记录" description="由服务端持久化记录配置变更、恢复、诊断和登录结果；敏感内容会在写入前脱敏。" action={
        <div className="page-actions"><button className="button ghost" onClick={() => load()} disabled={loading}>刷新</button><button className="button ghost" onClick={clear} disabled={loading}>清理记录</button></div>
      } />
      <section className="data-card audit-toolbar">
        <span>结果筛选</span>
        <Select value={outcome} onChange={setOutcome} ariaLabel="操作结果筛选"><option value="all">全部结果</option><option value="success">成功</option><option value="failure">失败</option></Select>
        <small>当前显示 {events.length} 条</small>
      </section>
      {error && <div className="subscription-error">{error}</div>}
      <section className="data-card log-list">
        {events.length ? events.map((event) => (
          <div className={`log-row ${event.outcome}`} key={event.eventId}>
            <span className="status-dot" />
            <time>{new Date(event.createdAt).toLocaleString("zh-CN", { hour12: false })}</time>
            <div className="log-content"><strong>{event.message}</strong><small>{ACTION_LABELS[event.action] || event.action} · {event.actor}{event.requestId ? ` · ${event.requestId}` : ""}</small></div>
          </div>
        )) : <div className="empty-state">{loading ? "正在读取操作记录…" : "暂无操作记录"}</div>}
        {nextBefore && <div className="audit-more"><button className="button ghost" disabled={loading} onClick={() => load({ append: true, before: nextBefore })}>{loading ? "读取中…" : "加载更早记录"}</button></div>}
      </section>
    </div>
  );
}
