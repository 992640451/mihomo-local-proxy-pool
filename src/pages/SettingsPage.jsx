import { PageHead, Select, formatDuration } from "../components/ui.jsx";

export function SettingsPage({ runtime, refreshSeconds, setRefreshSeconds, resetPorts, refresh }) {
  return (
    <div className="page-stack">
      <PageHead eyebrow="SYSTEM SETTINGS" title="系统设置" description="管理界面刷新、运行状态读取和端口配置同步。" />
      <section className="data-card settings-card">
        <label className="setting-row">
          <span>
            <strong>界面数据自动刷新</strong>
            <small>仅刷新管理界面；订阅的服务端刷新周期在订阅页单独设置</small>
          </span>
          <Select value={String(refreshSeconds)} onChange={(value) => setRefreshSeconds(Number(value))}>
            <option value="0">关闭</option>
            <option value="30">30 秒</option>
            <option value="60">1 分钟</option>
            <option value="300">5 分钟</option>
          </Select>
        </label>
        <div className="setting-row">
          <span><strong>立即刷新界面</strong><small>重新读取订阅、端口配置与 Mihomo 运行状态</small></span>
          <button className="button primary" onClick={refresh}>读取状态</button>
        </div>
        <div className="setting-row">
          <span><strong>重新同步端口配置</strong><small>丢弃当前界面状态并重新读取服务端端口配置</small></span>
          <button className="button danger" onClick={resetPorts}>重新同步</button>
        </div>
      </section>
      <section className="data-card">
        <h2>运行环境</h2>
        <dl className="detail-list">
          <div><dt>主机</dt><dd>{runtime.hostname}</dd></div>
          <div><dt>平台</dt><dd>{runtime.platform}</dd></div>
          <div><dt>服务进程运行时长</dt><dd>{formatDuration(runtime.processUptimeSeconds)}</dd></div>
          <div><dt>系统运行时长</dt><dd>{formatDuration(runtime.systemUptimeSeconds)}</dd></div>
        </dl>
      </section>
    </div>
  );
}
