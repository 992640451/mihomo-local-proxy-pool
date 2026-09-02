import { PageHead } from "../components/ui.jsx";

export function LogsPage({ logs, clear }) {
  return (
    <div className="page-stack">
      <PageHead
        eyebrow="LOCAL AUDIT"
        title="操作记录"
        description="记录当前浏览器内发生的配置读取与端口操作。"
        action={<button className="button ghost" onClick={clear}>清空记录</button>}
      />
      <section className="data-card log-list">
        {logs.length ? logs.map((log) => (
          <div className="log-row" key={log.id}>
            <span className="status-dot" />
            <time>{new Date(log.at).toLocaleString("zh-CN", { hour12: false })}</time>
            <strong>{log.text}</strong>
          </div>
        )) : <div className="empty-state">暂无操作记录</div>}
      </section>
    </div>
  );
}
