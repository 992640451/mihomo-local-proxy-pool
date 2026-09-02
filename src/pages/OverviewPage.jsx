import { MetricCard, PageHead, formatDuration } from "../components/ui.jsx";

export function OverviewPage({ catalog, runtime, ports }) {
  return (
    <div className="page-stack">
      <PageHead
        eyebrow="LIVE CONFIGURATION"
        title="系统总览"
        description="统计数据来自订阅库、端口配置和当前运行中的服务。"
      />
      <section className="metrics-grid">
        <MetricCard label="订阅节点" value={catalog.nodes.length} suffix="个" icon="nodes" meta={`${catalog.providers.length} 个订阅来源`} />
        <MetricCard label="识别国家/地区" value={catalog.countries.length} suffix="个" icon="grid" meta="按当前节点名称动态归类" />
        <MetricCard label="已启用端口配置" value={ports.filter((port) => port.enabled).length} suffix={`/ ${ports.length}`} icon="server" meta="服务端持久化配置" />
        <MetricCard label="服务进程运行时长" value={formatDuration(runtime.processUptimeSeconds)} icon="activity" meta={`${runtime.hostname} · ${runtime.platform}`} />
      </section>
      <section className="data-card">
        <h2>国家/地区分布</h2>
        <div className="country-grid">
          {catalog.countries.map((country) => (
            <div className="country-card" key={country.code}>
              <span>{country.flag}</span>
              <div>
                <strong>{country.name}</strong>
                <small>{country.code}</small>
              </div>
              <b>{country.count}</b>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
