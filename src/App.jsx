import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, GlobeSimple, Network } from "@phosphor-icons/react";
import { apiErrorMessage, apiFetch } from "./api.js";
import { Icon, PageHead, Select, formatDuration } from "./components/ui.jsx";
import { useCatalog } from "./hooks/useCatalog.js";
import { LogsPage } from "./pages/LogsPage.jsx";
import { OverviewPage } from "./pages/OverviewPage.jsx";
import { SettingsPage } from "./pages/SettingsPage.jsx";
import { UpdateCenter } from "./components/UpdateCenter.jsx";
import { NodesPage } from "./pages/NodesPage.jsx";
import { ObservabilityPage } from "./pages/ObservabilityPage.jsx";
import {
  PORT_STRATEGIES,
  dedupePortsByPort,
  enrichPort,
  filterPorts,
  mergeSelectedNodeIds,
  nextAvailablePort,
  normalizePort,
  proxyAddressesForPort,
  removePortById,
  reorderPortNode,
  validatePortDraft,
} from "./domain.js";

const NAV_ITEMS = [
  ["overview", "总览", "grid"],
  ["ports", "代理端口", "server"],
  ["nodes", "节点", "nodes"],
  ["observability", "可观测性", "activity"],
  ["subscriptions", "订阅", "file"],
  ["logs", "操作记录", "clipboard"],
  ["settings", "系统设置", "settings"],
];
const EMPTY_FILTERS = {
  provider: "全部订阅",
  country: "全部国家",
  status: "全部状态",
  query: "",
};
function SelectionBoxIcon({ state = "none", clear = false, size = 16 }) {
  return (
    <svg
      className="selection-box-icon"
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2.5" y="2.5" width="13" height="13" rx="1.5" />
      {clear ? (
        <>
          <path d="m6.2 6.2 5.6 5.6" />
          <path d="m11.8 6.2-5.6 5.6" />
        </>
      ) : state === "all" ? (
        <path d="m5.5 9 2.3 2.3 4.8-5" />
      ) : state === "partial" ? (
        <path d="M5.5 9h7" />
      ) : null}
    </svg>
  );
}

function formatCheckAge(checkedAt) {
  const timestamp = new Date(checkedAt).getTime();
  if (!Number.isFinite(timestamp)) return "已检测";
  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - timestamp) / 1000),
  );
  if (elapsedSeconds < 60) return "刚刚检测";
  if (elapsedSeconds < 3600) return `${Math.floor(elapsedSeconds / 60)} 分钟前`;
  return `${new Date(timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })} 检测`;
}

function ListenerCheck({ port, testing = false }) {
  const check = port.listenerCheck;
  const isGlobal = port.isGlobal;
  let state = check?.state || "idle";
  let label = isGlobal ? "待检测" : "未检测";
  let meta = port.enabled === false ? "配置已停用" : "点击右侧检测";

  if (testing) {
    state = "checking";
    label = "检测中";
    meta = isGlobal ? "正在检测出口" : "正在检查端口";
  } else if (state === "online") {
    label = isGlobal ? "出口正常" : "可连接";
    meta = formatCheckAge(check.checkedAt);
  } else if (state === "offline") {
    label = "连接失败";
    meta = formatCheckAge(check.checkedAt);
  } else if (state === "error") {
    label = "检测异常";
    meta = formatCheckAge(check.checkedAt);
  } else if (/已写入|已重载/.test(port.lastChecked || "")) {
    meta = "配置已更新";
  }

  const hasLatency =
    check?.latencyMs !== null &&
    check?.latencyMs !== undefined &&
    Number.isFinite(Number(check.latencyMs));
  const latency = hasLatency ? Number(check.latencyMs) : null;
  const accessibleText = `${label}${latency === null ? "" : `，延迟 ${latency} 毫秒`}，${meta}`;
  return (
    <div
      className={`listener-check ${state}`}
      title={accessibleText}
      aria-label={accessibleText}
    >
      <div className="listener-check-main">
        <span className="listener-check-status">
          <i aria-hidden="true" />
          {label}
        </span>
        {latency !== null && (
          <span className="listener-check-latency">{latency} ms</span>
        )}
      </div>
      <small>{meta}</small>
    </div>
  );
}

async function writeClipboardText(value) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {}

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("clipboard unavailable");
}

function ProxyAddressCopy({ port, onNotice }) {
  const addresses = proxyAddressesForPort(port);
  const disabled = port.enabled === false;
  const [copiedProtocol, setCopiedProtocol] = useState(null);
  const copiedTimerRef = useRef(null);

  useEffect(
    () => () => window.clearTimeout(copiedTimerRef.current),
    [],
  );

  const copy = async (address) => {
    try {
      await writeClipboardText(address.url);
      setCopiedProtocol(address.protocol);
      window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(
        () => setCopiedProtocol(null),
        1500,
      );
      const listenerWarning = ["offline", "error"].includes(
        port.listenerCheck?.state,
      );
      onNotice({
        tone: listenerWarning ? "warning" : "success",
        text: `已复制 ${address.protocol} 代理：${address.url}${listenerWarning ? "（最近一次检测不可连接）" : ""}`,
      });
    } catch {
      onNotice({
        tone: "danger",
        text: `复制失败，请手动复制：${address.url}`,
      });
    }
  };

  return (
    <div className="proxy-address-copy">
      <strong className="mono">{port.port}</strong>
      <span className="proxy-copy-actions">
        {addresses.map((address) => {
          const copied = copiedProtocol === address.protocol;
          const AddressIcon = copied
            ? Check
            : address.protocol === "HTTP"
              ? GlobeSimple
              : Network;
          const buttonLabel = disabled
            ? `端口 ${port.port} 已停用，无法复制 ${address.protocol} 代理地址`
            : `复制 ${address.protocol} 代理地址 ${address.url}`;
          return (
            <button
              type="button"
              key={address.protocol}
              className={`proxy-copy-button ${address.protocol.toLowerCase()}${copied ? " copied" : ""}`}
              data-copy-protocol={address.protocol}
              disabled={disabled}
              title={buttonLabel}
              aria-label={buttonLabel}
              onClick={() => copy(address)}
            >
              <AddressIcon size={16} weight={copied ? "bold" : "regular"} />
            </button>
          );
        })}
      </span>
    </div>
  );
}

function LoginScreen({ onLogin }) {
  const [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [remember, setRemember] = useState(true),
    [error, setError] = useState(""),
    [submitting, setSubmitting] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const response = await apiFetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, remember }),
      });
      if (!response.ok)
        throw new Error(
          response.status === 429
            ? "尝试次数过多，请稍后再试"
            : "账号或密码不正确",
        );
      onLogin();
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <main className="login-screen">
      <section className="login-card">
        <div className="login-brand">
          <span className="brand-mark">
            <i />
            <i />
            <i />
          </span>
          <div>
            <span className="eyebrow">SECURE ACCESS</span>
            <h1>代理端口管理</h1>
          </div>
        </div>
        <p>请输入账号和密码以读取服务器代理配置。</p>
        <form onSubmit={submit}>
          <label className="login-field">
            <span>账号</span>
            <input
              autoFocus
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </label>
          <label className="login-field">
            <span>密码</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          <label className="remember-row">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span className="remember-check">
              <Icon name="check" size={12} />
            </span>
            <span>
              <strong>记住密码</strong>
              <small>在此设备上保持登录 30 天</small>
            </span>
          </label>
          {error && <div className="login-error">{error}</div>}
          <button className="button primary login-submit" disabled={submitting}>
            {submitting ? "校验中…" : "登录"}
          </button>
        </form>
        <small>
          密码不会写入浏览器存储；系统仅保存可随时注销的安全登录凭证
        </small>
      </section>
    </main>
  );
}

function PortDrawer({
  mode,
  port,
  ports,
  nodes,
  providers,
  countries,
  onClose,
  onSave,
}) {
  const source = normalizePort(
    mode === "edit" && port
      ? port
      : {
          port: nextAvailablePort(ports) ?? "",
          protocol: "Mixed",
          nodeIds: [],
          strategy: "fallback",
          enabled: true,
        },
  );
  const [draft, setDraft] = useState(source);
  const [provider, setProvider] = useState("全部订阅"),
    [country, setCountry] = useState("全部国家"),
    [query, setQuery] = useState(""),
    [error, setError] = useState("");
  const nodesById = useMemo(
    () => new Map(nodes.map((node) => [node.id, node])),
    [nodes],
  );
  const selectedNodes = draft.nodeIds
    .map((id) => nodesById.get(id))
    .filter(Boolean);
  const selectedIdSet = useMemo(() => new Set(draft.nodeIds), [draft.nodeIds]);
  const selectedIndexById = useMemo(
    () => new Map(draft.nodeIds.map((id, index) => [id, index])),
    [draft.nodeIds],
  );
  const visible = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return nodes.filter(
      (n) =>
        (provider === "全部订阅" || n.provider === provider) &&
        (country === "全部国家" || n.country === country) &&
        (!normalizedQuery || n.name.toLowerCase().includes(normalizedQuery)),
    );
  }, [nodes, provider, country, query]);
  const visibleIds = useMemo(() => visible.map((node) => node.id), [visible]);
  const visibleSelectedCount = visibleIds.reduce(
    (count, id) => count + Number(selectedIdSet.has(id)),
    0,
  );
  const visibleSelectionState = !visibleSelectedCount
    ? "none"
    : visibleSelectedCount === visibleIds.length
      ? "all"
      : "partial";
  const update = (patch) => {
    setDraft((current) => normalizePort({ ...current, ...patch }));
    setError("");
  };
  const updateNodeIds = (transform) => {
    setDraft((current) =>
      normalizePort({ ...current, nodeIds: transform(current.nodeIds) }),
    );
    setError("");
  };
  const toggleNode = (nodeId) =>
    updateNodeIds((current) =>
      current.includes(nodeId)
        ? current.filter((id) => id !== nodeId)
        : [...current, nodeId],
    );
  const moveNode = (nodeId, direction) =>
    updateNodeIds((current) => reorderPortNode(current, nodeId, direction));
  const selectAllVisible = () =>
    updateNodeIds((current) => mergeSelectedNodeIds(current, visibleIds));
  const clearAllNodes = () => updateNodeIds(() => []);
  const option = (key, value) =>
    update({ strategyOptions: { ...draft.strategyOptions, [key]: value } });
  const submit = () => {
    const message = validatePortDraft(
      draft,
      ports,
      mode === "edit" ? port.id : null,
    );
    if (message) return setError(message);
    onSave(normalizePort({ ...draft, port: Number(draft.port) }));
  };
  return (
    <aside className="drawer pool-drawer">
      <div className="drawer-head">
        <div>
          <span className="eyebrow">PORT POOL</span>
          <h2>{mode === "edit" ? "修改代理端口" : "新建代理端口"}</h2>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="关闭">
          <Icon name="close" />
        </button>
      </div>
      <div className="drawer-scroll">
        <section className="drawer-section">
          <div className="field-row">
            <label className="field">
              <span>端口</span>
              <input
                disabled={mode === "edit"}
                value={draft.port}
                onChange={(e) => update({ port: e.target.value })}
              />
            </label>
            <label className="field">
              <span>协议</span>
              <Select
                value={draft.protocol}
                onChange={(protocol) => update({ protocol })}
              >
                <option>Mixed</option>
                <option>HTTP</option>
                <option>SOCKS5</option>
              </Select>
            </label>
          </div>
          <label className="toggle-row">
            <span>
              <strong>启用配置</strong>
              <small>标记该端口为启用</small>
            </span>
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => update({ enabled: e.target.checked })}
            />
            <i />
          </label>
        </section>
        <section className="drawer-section">
          <div className="section-title">
            <div>
              <span className="eyebrow">ROUTE STRATEGY</span>
              <h3>节点使用方式</h3>
            </div>
          </div>
          <div className="strategy-grid">
            {Object.entries(PORT_STRATEGIES).map(([id, meta]) => (
              <button
                type="button"
                className={`strategy-card ${draft.strategy === id ? "selected" : ""}`}
                key={id}
                onClick={() => update({ strategy: id })}
              >
                <strong>{meta.label}</strong>
                <small>{meta.description}</small>
              </button>
            ))}
          </div>
        </section>
        {draft.strategy !== "select" && (
          <section className="drawer-section strategy-options">
            <div className="section-title">
              <div>
                <span className="eyebrow">HEALTH CHECK</span>
                <h3>健康检查</h3>
              </div>
            </div>
            <label className="field wide">
              <span>检测地址</span>
              <input
                value={draft.strategyOptions.healthCheckUrl}
                onChange={(e) => option("healthCheckUrl", e.target.value)}
              />
            </label>
            <div className="field-row compact">
              <label className="field">
                <span>周期（秒）</span>
                <input
                  type="number"
                  min="10"
                  max="86400"
                  value={draft.strategyOptions.intervalSeconds}
                  onChange={(e) =>
                    option("intervalSeconds", Number(e.target.value))
                  }
                />
              </label>
              <label className="field">
                <span>超时（毫秒）</span>
                <input
                  type="number"
                  min="500"
                  max="60000"
                  value={draft.strategyOptions.timeoutMs}
                  onChange={(e) => option("timeoutMs", Number(e.target.value))}
                />
              </label>
            </div>
            <div className="field-row compact">
              <label className="field">
                <span>最大失败次数</span>
                <input
                  type="number"
                  min="1"
                  max="20"
                  value={draft.strategyOptions.maxFailedTimes}
                  onChange={(e) =>
                    option("maxFailedTimes", Number(e.target.value))
                  }
                />
              </label>
              {draft.strategy === "url-test" && (
                <label className="field">
                  <span>切换容差（毫秒）</span>
                  <input
                    type="number"
                    min="0"
                    max="5000"
                    value={draft.strategyOptions.toleranceMs}
                    onChange={(e) =>
                      option("toleranceMs", Number(e.target.value))
                    }
                  />
                </label>
              )}
            </div>
            {draft.strategy === "fallback" && (
              <small>节点将按下方顺序检查；切换对新建连接生效。</small>
            )}
          </section>
        )}
        <section className="drawer-section selected-pool">
          <div className="section-title">
            <div>
              <span className="eyebrow">SELECTED POOL</span>
              <h3>已选择节点</h3>
            </div>
            <div className="section-title-actions">
              <span className="section-count">{selectedNodes.length} 个</span>
              <button
                type="button"
                className="bulk-icon-button clear"
                disabled={!draft.nodeIds.length}
                onClick={clearAllNodes}
                aria-label="取消全部选择"
                title="取消全部选择"
              >
                <SelectionBoxIcon clear />
              </button>
            </div>
          </div>
          {selectedNodes.length ? (
            <div className="pool-order">
              {selectedNodes.map((node, index) => (
                <div className="pool-node" key={node.id}>
                  <b>{index === 0 ? "主" : index}</b>
                  <span className="flag">{node.flag}</span>
                  <span className="node-copy">
                    <strong>{node.name}</strong>
                    <small>
                      {index === 0 ? "当前首选" : "备用/候选"} · {node.country}
                    </small>
                  </span>
                  <span className="order-actions">
                    <button
                      type="button"
                      disabled={!index}
                      onClick={() => moveNode(node.id, -1)}
                      aria-label="上移"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      disabled={index === selectedNodes.length - 1}
                      onClick={() => moveNode(node.id, 1)}
                      aria-label="下移"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleNode(node.id)}
                      aria-label="移除"
                    >
                      ×
                    </button>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="pool-empty">从下方目录选择一个或多个节点</div>
          )}
        </section>
        <section className="drawer-section">
          <div className="section-title">
            <div>
              <span className="eyebrow">ROUTE TARGETS</span>
              <h3>选择订阅节点</h3>
            </div>
            <div className="section-title-actions">
              <span className="section-count">{visible.length} 个</span>
              <button
                type="button"
                className="bulk-icon-button"
                data-state={visibleSelectionState}
                disabled={!visible.length || visibleSelectionState === "all"}
                onClick={selectAllVisible}
                aria-label={
                  visibleSelectionState === "all"
                    ? "当前结果已全选"
                    : "全选当前结果"
                }
                title={
                  visibleSelectionState === "all"
                    ? "当前结果已全选"
                    : "全选当前结果"
                }
              >
                <SelectionBoxIcon state={visibleSelectionState} />
              </button>
            </div>
          </div>
          <div className="node-filters">
            <Select value={provider} onChange={setProvider}>
              <option>全部订阅</option>
              {providers.map((p) => (
                <option key={p.id}>{p.name}</option>
              ))}
            </Select>
            <Select value={country} onChange={setCountry}>
              <option>全部国家</option>
              {countries.map((c) => (
                <option key={c.code}>{c.name}</option>
              ))}
            </Select>
          </div>
          <label className="search small">
            <Icon name="search" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索节点"
            />
          </label>
          <div className="node-list">
            {visible.map((node) => {
              const selected = selectedIdSet.has(node.id);
              return (
                <button
                  type="button"
                  className={`node-option ${selected ? "selected" : ""}`}
                  key={node.id}
                  onClick={() => toggleNode(node.id)}
                >
                  <span className="checkbox">
                    <Icon name="check" size={11} />
                  </span>
                  <span className="flag">{node.flag}</span>
                  <span className="node-copy">
                    <strong>{node.name}</strong>
                    <small>
                      {node.provider} · {node.country}
                    </small>
                  </span>
                  {selected && (
                    <span className="picked-index">
                      #{selectedIndexById.get(node.id) + 1}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      </div>
      {error && <div className="form-error">{error}</div>}
      <div className="drawer-footer">
        <button className="button ghost" onClick={onClose}>
          取消
        </button>
        <button className="button primary" onClick={submit}>
          <Icon name="check" />
          保存配置
        </button>
      </div>
    </aside>
  );
}

function PoolVerificationDialog({ verification, onClose }) {
  if (!verification) return null;
  const { port, result } = verification;
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="verification-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="verification-title"
      >
        <header>
          <div>
            <span className="eyebrow">POOL VERIFICATION</span>
            <h2 id="verification-title">端口 {port} 验证结果</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <Icon name="close" />
          </button>
        </header>
        <div className="verification-metrics">
          <div>
            <strong>
              {result.successes}/{result.attempts}
            </strong>
            <span>成功连接</span>
          </div>
          <div>
            <strong>{result.uniqueExitCount}</strong>
            <span>唯一出口</span>
          </div>
          <div>
            <strong>{result.failures}</strong>
            <span>失败连接</span>
          </div>
        </div>
        <div className="verification-list">
          {result.distribution.map((exit) => (
            <div className="verification-exit" key={exit.ip}>
              <span className="flag">{exit.flag || "🌐"}</span>
              <div>
                <strong>{exit.ip}</strong>
                <small>
                  {exit.country}
                  {exit.region ? ` · ${exit.region}` : ""}
                </small>
              </div>
              <b>{exit.count} 次</b>
              <span>{exit.averageLatencyMs} ms</span>
            </div>
          ))}
          {!result.distribution.length && (
            <div className="pool-empty">没有检测到可用出口</div>
          )}
        </div>
        {result.failures > 0 && (
          <p className="verification-note">
            有 {result.failures}{" "}
            次连接失败；可在节点健康状态中继续检查不可用节点。
          </p>
        )}
        <footer>
          <button className="button primary" onClick={onClose}>
            完成
          </button>
        </footer>
      </section>
    </div>
  );
}

function PortsPage({ ports, setPorts, nodes, providers, countries, addLog }) {
  const [filters, setFilters] = useState(EMPTY_FILTERS),
    [drawer, setDrawer] = useState({ open: false, mode: "new", id: null }),
    [testing, setTesting] = useState(null),
    [verifying, setVerifying] = useState(null),
    [verification, setVerification] = useState(null),
    [deleting, setDeleting] = useState(null),
    [applying, setApplying] = useState(false),
    [applyError, setApplyError] = useState(""),
    [copyNotice, setCopyNotice] = useState(null);
  const enriched = ports.map((p) => enrichPort(p, nodes)),
    visible = filterPorts(ports, filters, nodes).map((p) =>
      enrichPort(p, nodes),
    ),
    selected = enriched.find((p) => p.id === drawer.id);
  useEffect(() => {
    if (!copyNotice) return undefined;
    const timer = window.setTimeout(() => setCopyNotice(null), 2600);
    return () => window.clearTimeout(timer);
  }, [copyNotice]);
  const save = async (rawDraft) => {
    const draft = normalizePort(rawDraft);
    setApplying(true);
    setApplyError("");
    try {
      const response = await apiFetch(`/ports/${draft.port}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeId: draft.nodeId,
          nodeIds: draft.nodeIds,
          strategy: draft.strategy,
          strategyOptions: draft.strategyOptions,
          protocol: draft.protocol,
          enabled: draft.enabled,
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(apiErrorMessage(result, "端口配置应用失败"));
      const applied = {
        ...draft,
        ...result,
        id:
          drawer.mode === "edit" ? drawer.id : `mihomo-listener-${draft.port}`,
        managedBy: result.embeddedCore ? "embedded-mihomo" : "mihomo",
        routeName: result.routeName || result.proxy,
        listenerName: `ppm-${draft.port}`,
        listenerCheck: null,
        lastChecked: result.reloaded ? "已写入并重载" : "已写入，等待核心重载",
      };
      setPorts((cur) =>
        dedupePortsByPort(
          drawer.mode === "edit"
            ? cur.map((p) => (p.id === drawer.id ? applied : p))
            : [...cur, applied],
        ),
      );
      addLog(
        `应用端口 ${draft.port}：${result.proxy}${result.reloaded ? "，Mihomo 已重载" : "，等待核心重载"}`,
      );
      setDrawer({ open: false, mode: "new", id: null });
    } catch (error) {
      setApplyError(error.message);
    } finally {
      setApplying(false);
    }
  };
  const test = async (p) => {
    setTesting(p.id);
    setApplyError("");
    try {
      const r = await apiFetch(
          `/ports/${p.port}/${p.isGlobal ? "egress" : "test"}`,
        ),
        data = await r.json();
      if (!r.ok) throw new Error(apiErrorMessage(data, "端口检测失败"));
      const checkedAt = data.checkedAt || new Date().toISOString();
      if (p.isGlobal) {
        setPorts((cur) =>
          cur.map((x) =>
            x.id === p.id
              ? {
                  ...x,
                  egress: data,
                  listenerCheck: {
                    state: "online",
                    latencyMs: data.latencyMs,
                    checkedAt,
                  },
                  lastChecked: `出口检测 · ${data.flag || "🌐"} ${data.country} · ${data.latencyMs}ms`,
                }
              : x,
          ),
        );
        addLog(
          `检测全局入口 ${p.port}：${data.country} ${data.region || ""} ${data.city || ""} · ${data.ip}`,
        );
      } else {
        let status = null;
        if (p.managedBy === "embedded-mihomo") {
          try {
            const statusResponse = await apiFetch(`/ports/${p.port}/status`);
            if (statusResponse.ok) status = await statusResponse.json();
          } catch {}
        }
        const active = status?.activeNodeName || null,
          detail = active
            ? ` · 当前 ${active}`
            : data.proxy
              ? ` · ${data.proxy}`
              : "";
        setPorts((cur) =>
          cur.map((x) =>
            x.id === p.id
              ? {
                  ...x,
                  activeNodeId: status?.activeNodeId || x.activeNodeId,
                  activeNodeName: active || x.activeNodeName,
                  listenerCheck: {
                    state: data.open ? "online" : "offline",
                    latencyMs: data.open ? data.latencyMs : null,
                    checkedAt,
                  },
                  lastChecked: data.open
                    ? `监听可连接 · ${data.latencyMs}ms`
                    : "监听连接失败",
                }
              : x,
          ),
        );
        addLog(
          `检测端口 ${p.port}：${data.open ? "监听可连接" : "监听连接失败"}${detail}`,
        );
      }
    } catch (error) {
      const checkedAt = new Date().toISOString();
      setApplyError(error.message);
      setPorts((cur) =>
        cur.map((x) =>
          x.id === p.id
            ? {
                ...x,
                listenerCheck: { state: "error", latencyMs: null, checkedAt },
                lastChecked: p.isGlobal ? "出口检测失败" : "监听检测异常",
              }
            : x,
        ),
      );
    } finally {
      setTesting(null);
    }
  };
  const verify = async (p) => {
    setVerifying(p.id);
    setApplyError("");
    try {
      const response = await apiFetch(`/ports/${p.port}/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ attempts: 8 }),
        }),
        result = await response.json();
      if (!response.ok)
        throw new Error(apiErrorMessage(result, "代理池验证失败"));
      setVerification({ port: p.port, result });
      addLog(
        `验证端口 ${p.port}：${result.successes}/${result.attempts} 成功，${result.uniqueExitCount} 个出口`,
      );
    } catch (error) {
      setApplyError(error.message);
    } finally {
      setVerifying(null);
    }
  };
  const remove = async (p) => {
    if (!window.confirm(`确定删除端口 ${p.port} 的代理配置吗？`)) return;
    setDeleting(p.id);
    setApplyError("");
    try {
      if (["mihomo", "embedded-mihomo"].includes(p.managedBy)) {
        const response = await apiFetch(`/ports/${p.port}`, {
            method: "DELETE",
          }),
          result = await response.json();
        if (!response.ok)
          throw new Error(apiErrorMessage(result, "端口配置删除失败"));
        if (!result.removed)
          throw new Error("该端口不是可删除的监听配置");
        addLog(
          `删除端口 ${p.port}：${result.reloaded ? "Mihomo 已重载" : result.reloadRequired ? "等待核心重载" : "配置已移除"}`,
        );
      } else addLog(`删除端口 ${p.port} 本地配置`);
      setPorts((cur) => removePortById(cur, p.id));
    } catch (error) {
      setApplyError(error.message);
    } finally {
      setDeleting(null);
    }
  };
  return (
    <div className="page-stack">
      <PageHead
        eyebrow="PORT POOLS"
        title="代理端口"
        description="每个端口由独立的 Mihomo 监听和策略组提供服务，可使用已导入订阅中的节点，并按所选策略自动路由。"
      />
      {applyError && (
        <div className="toast danger">
          <span>!</span>
          {applyError}
        </div>
      )}
      {copyNotice && (
        <div
          className={`toast copy-toast ${copyNotice.tone}${applyError ? " stacked" : ""}`}
          role="status"
          aria-live="polite"
        >
          <span>{copyNotice.tone === "danger" ? "!" : "✓"}</span>
          {copyNotice.text}
        </div>
      )}
      <section className="control-panel">
        <div className="toolbar">
          <button
            className="button create"
            onClick={() => setDrawer({ open: true, mode: "new", id: null })}
          >
            新建端口池
            <Icon name="plus" />
          </button>
          <Select
            value={filters.provider}
            onChange={(provider) => setFilters({ ...filters, provider })}
          >
            <option>全部订阅</option>
            {providers.map((p) => (
              <option key={p.id}>{p.name}</option>
            ))}
          </Select>
          <Select
            value={filters.country}
            onChange={(country) => setFilters({ ...filters, country })}
          >
            <option>全部国家</option>
            {countries.map((c) => (
              <option key={c.code}>{c.name}</option>
            ))}
          </Select>
          <Select
            value={filters.status}
            onChange={(status) => setFilters({ ...filters, status })}
          >
            <option>全部状态</option>
            <option>在线</option>
            <option>已停用</option>
          </Select>
          <label className="search">
            <Icon name="search" />
            <input
              value={filters.query}
              onChange={(e) =>
                setFilters({ ...filters, query: e.target.value })
              }
              placeholder="搜索端口 / 策略 / 节点 / 国家"
            />
          </label>
        </div>
        <div className="table-wrap">
          <table className="ports-table">
            <colgroup>
              <col className="col-port" />
              <col className="col-protocol" />
              <col className="col-provider" />
              <col className="col-country" />
              <col className="col-route" />
              <col className="col-check" />
              <col className="col-status" />
              <col className="col-actions" />
            </colgroup>
            <thead>
              <tr>
                <th>端口</th>
                <th>协议</th>
                <th>订阅</th>
                <th>国家</th>
                <th>节点池策略</th>
                <th>监听检测</th>
                <th>配置状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => {
                const providerNames = [
                    ...new Set(p.nodes.map((n) => n.provider)),
                  ],
                  countryNames = [...new Set(p.nodes.map((n) => n.country))];
                return (
                  <tr key={p.id}>
                    <td className="port-cell">
                      <ProxyAddressCopy port={p} onNotice={setCopyNotice} />
                    </td>
                    <td>{p.protocol}</td>
                    <td
                      title={
                        p.isGlobal ? "系统配置" : providerNames.join("、")
                      }
                    >
                      {p.isGlobal ? "系统配置" : providerNames[0]}
                      {!p.isGlobal && providerNames.length > 1
                        ? ` +${providerNames.length - 1}`
                        : ""}
                    </td>
                    <td>
                      <span className="country">
                        {p.isGlobal
                          ? p.egress
                            ? `${p.egress.flag || "🌐"} ${p.egress.country}`
                            : "🌐 待检测"
                          : `${p.node?.flag || ""} ${countryNames[0] || ""}${countryNames.length > 1 ? ` +${countryNames.length - 1}` : ""}`}
                      </span>
                    </td>
                    <td>
                      <div className="pool-summary">
                        <strong>
                          {p.routeName ||
                            `${p.strategyMeta.label} · ${p.nodes.length} 节点`}
                        </strong>
                        <small>
                          {p.isGlobal
                            ? p.egress
                              ? `当前出口：${p.egress.region || p.egress.country}${p.egress.city ? ` · ${p.egress.city}` : ""} · ${p.egress.ip}`
                              : "点击检测获取当前出口国家"
                            : p.activeNodeName
                              ? `当前活动：${p.activeNodeName}`
                              : p.node
                                ? `当前首选：${p.node.name}`
                                : "无可用节点"}
                        </small>
                      </div>
                    </td>
                    <td className="check-cell">
                      <ListenerCheck port={p} testing={testing === p.id} />
                    </td>
                    <td className="status-cell">
                      <span
                        className={`status-pill ${p.enabled ? "online" : "offline"}`}
                      >
                        {p.isGlobal
                          ? "全局监听"
                          : p.managedBy === "embedded-mihomo"
                            ? "受管监听"
                            : p.managedBy === "mihomo"
                              ? "Mihomo 监听"
                              : p.enabled
                                ? "已启用"
                                : "已停用"}
                      </span>
                    </td>
                    <td className="actions-cell">
                      <div className="actions">
                        {!p.isGlobal && (
                          <button
                            disabled={applying || deleting === p.id}
                            onClick={() =>
                              setDrawer({ open: true, mode: "edit", id: p.id })
                            }
                          >
                            {applying ? "应用中" : "修改"}
                          </button>
                        )}
                        <button
                          disabled={
                            testing === p.id ||
                            deleting === p.id ||
                            verifying === p.id
                          }
                          onClick={() => test(p)}
                        >
                          {testing === p.id ? "检测中" : "检测"}
                        </button>
                        {!p.isGlobal && (
                          <button
                            disabled={
                              verifying === p.id ||
                              deleting === p.id ||
                              testing === p.id
                            }
                            onClick={() => verify(p)}
                          >
                            {verifying === p.id ? "验证中" : "验证"}
                          </button>
                        )}
                        {!p.isGlobal && (
                          <button
                            className="delete"
                            disabled={deleting === p.id || verifying === p.id}
                            onClick={() => remove(p)}
                          >
                            {deleting === p.id ? "删除中" : "删除"}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!visible.length && (
            <div className="empty-state">没有符合条件的端口</div>
          )}
        </div>
      </section>
      {drawer.open && (
        <PortDrawer
          mode={drawer.mode}
          port={selected}
          ports={ports}
          nodes={nodes}
          providers={providers}
          countries={countries}
          onClose={() => setDrawer({ ...drawer, open: false })}
          onSave={save}
        />
      )}
      <PoolVerificationDialog
        verification={verification}
        onClose={() => setVerification(null)}
      />
    </div>
  );
}


function SubscriptionsPage({ catalog, refresh }) {
  const [items, setItems] = useState([]),
    [mode, setMode] = useState("url"),
    [form, setForm] = useState({
      name: "",
      url: "",
      content: "",
      priority: 0,
      refreshIntervalSeconds: 3600,
    }),
    [busy, setBusy] = useState(""),
    [message, setMessage] = useState(""),
    [preview, setPreview] = useState(null),
    [editing, setEditing] = useState(null);
  const load = useCallback(async () => {
    const response = await apiFetch("/subscriptions");
    const data = await response.json();
    if (!response.ok)
      throw new Error(apiErrorMessage(data, "订阅列表读取失败"));
    setItems(data.subscriptions || []);
  }, []);
  useEffect(() => {
    load().catch((error) => setMessage(error.message));
  }, [load]);
  const run = async (key, action) => {
    setBusy(key);
    setMessage("");
    try {
      await action();
    } catch (error) {
      setMessage(error.message);
    } finally {
      await Promise.allSettled([load(), refresh()]);
      setBusy("");
    }
  };
  const request = async (path, options) => {
    const response = await apiFetch(path, options),
      data = response.status === 204 ? null : await response.json();
    if (!response.ok)
      throw new Error(apiErrorMessage(data));
    return data;
  };
  const body = () => ({
    name: form.name,
    priority: Number(form.priority),
    refreshIntervalSeconds: Number(form.refreshIntervalSeconds),
    ...(mode === "url" ? { url: form.url } : { content: form.content }),
  });
  const doPreview = () =>
    run("preview", async () =>
      setPreview(
        await request("/subscriptions/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body()),
        }),
      ),
    );
  const create = () =>
    run("create", async () => {
      await request("/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body()),
      });
      setForm({
        name: "",
        url: "",
        content: "",
        priority: 0,
        refreshIntervalSeconds: 3600,
      });
      setPreview(null);
    });
  const openSettings = (item) =>
    setEditing({
      id: item.id,
      sourceType: item.sourceType,
      name: item.name,
      priority: item.priority || 0,
      enabled: item.enabled,
      refreshIntervalSeconds: item.refreshIntervalSeconds,
      url: "",
      maskedUrl: item.url,
    });
  const saveSettings = async (event) => {
    event.preventDefault();
    setBusy(`edit-${editing.id}`);
    setMessage("");
    try {
      const patch = {
        name: editing.name,
        priority: Number(editing.priority),
        enabled: editing.enabled,
        refreshIntervalSeconds: Number(editing.refreshIntervalSeconds),
      };
      if (editing.sourceType === "url" && editing.url.trim())
        patch.url = editing.url.trim();
      await request(`/subscriptions/${editing.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      setEditing(null);
    } catch (error) {
      setMessage(error.message);
    } finally {
      await Promise.allSettled([load(), refresh()]);
      setBusy("");
    }
  };
  const formatTime = (value) =>
    value
      ? new Date(value).toLocaleString("zh-CN", { hour12: false })
      : "尚未成功";
  return (
    <div className="page-stack">
      <PageHead
        eyebrow="NATIVE SUBSCRIPTIONS"
        title="订阅"
        description="优先级越大排序越靠前，并统一影响节点目录和端口池中的订阅下拉框。"
        action={
          <button
            className="button primary"
            disabled={Boolean(busy)}
            onClick={() =>
              run("all", () =>
                request("/subscriptions/refresh-all", { method: "POST" }),
              )
            }
          >
            <Icon name="refresh" />
            {busy === "all" ? "刷新中…" : "刷新全部"}
          </button>
        }
      />
      {message && <div className="subscription-message">{message}</div>}
      <section className="data-card subscription-import">
        <div className="subscription-import-head">
          <div>
            <span className="eyebrow">IMPORT</span>
            <h2>导入新订阅</h2>
          </div>
          <Select
            value={mode}
            onChange={(value) => {
              setMode(value);
              setPreview(null);
            }}
          >
            <option value="url">订阅 URL</option>
            <option value="yaml">粘贴 YAML</option>
          </Select>
        </div>
        <div className="subscription-form">
          <label>
            <span>名称</span>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="例如：主力订阅"
            />
          </label>
          <label>
            <span>服务端刷新周期</span>
            <Select
              value={String(form.refreshIntervalSeconds)}
              onChange={(value) =>
                setForm({ ...form, refreshIntervalSeconds: Number(value) })
              }
            >
              <option value="900">15 分钟</option>
              <option value="3600">1 小时</option>
              <option value="21600">6 小时</option>
              <option value="86400">24 小时</option>
            </Select>
          </label>
          <label>
            <span>优先级</span>
            <input
              type="number"
              min="-10000"
              max="10000"
              value={form.priority}
              onChange={(e) => setForm({ ...form, priority: e.target.value })}
            />
          </label>
          {mode === "url" ? (
            <label className="wide">
              <span>订阅 URL</span>
              <input
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder="https://example.com/subscription?token=…"
              />
            </label>
          ) : (
            <label className="wide">
              <span>Mihomo / Clash YAML</span>
              <textarea
                value={form.content}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
                placeholder="proxies:&#10;  - name: …"
              />
            </label>
          )}
        </div>
        {preview && (
          <div className="subscription-preview">
            <strong>解析成功：{preview.nodeCount} 个节点</strong>
            <span>{preview.sample.map((item) => item.name).join("、")}</span>
          </div>
        )}
        <div className="subscription-actions">
          <button
            className="button ghost"
            disabled={Boolean(busy) || (!form.url && !form.content)}
            onClick={doPreview}
          >
            {busy === "preview" ? "解析中…" : "预览解析"}
          </button>
          <button
            className="button primary"
            disabled={
              Boolean(busy) || !form.name || (!form.url && !form.content)
            }
            onClick={create}
          >
            {busy === "create" ? "导入中…" : "导入订阅"}
          </button>
        </div>
      </section>
      <div className="subscription-grid">
        {items.map((item) => (
          <article
            className={`data-card subscription-card ${item.lastError ? "has-error" : ""}`}
            key={item.id}
          >
            <div className="subscription-card-head">
              <span className="eyebrow">
                {item.sourceType.toUpperCase()} / {item.id.slice(0, 8)}
              </span>
              <div className="subscription-badges">
                <span className="priority-pill">
                  优先级 {item.priority || 0}
                </span>
                <span
                  className={`status-pill ${item.enabled ? "online" : "offline"}`}
                >
                  {item.enabled ? "已启用" : "已停用"}
                </span>
              </div>
            </div>
            <h2>{item.name}</h2>
            <strong className="big-number">{item.nodeCount}</strong>
            <span> 个节点</span>
            <p className="mono path-text">
              {item.url || "本地粘贴内容"}
              <br />
              上次成功：{formatTime(item.lastSuccessAt)}
              <br />
              刷新周期：{Math.round(item.refreshIntervalSeconds / 60)} 分钟
            </p>
            {item.lastError && (
              <p className="subscription-error">{item.lastError}</p>
            )}
            <div className="subscription-actions">
              <button
                className="button ghost"
                disabled={Boolean(busy)}
                onClick={() => openSettings(item)}
              >
                设置
              </button>
              <button
                className="button ghost"
                disabled={Boolean(busy) || item.sourceType !== "url"}
                onClick={() =>
                  run(`refresh-${item.id}`, () =>
                    request(`/subscriptions/${item.id}/refresh`, {
                      method: "POST",
                    }),
                  )
                }
              >
                {busy === `refresh-${item.id}` ? "刷新中…" : "刷新"}
              </button>
              <button
                className="button danger"
                disabled={Boolean(busy)}
                onClick={() => {
                  if (window.confirm(`确定删除订阅“${item.name}”吗？`))
                    run(`delete-${item.id}`, () =>
                      request(`/subscriptions/${item.id}`, {
                        method: "DELETE",
                      }),
                    );
                }}
              >
                删除
              </button>
            </div>
          </article>
        ))}
      </div>
      {!items.length && (
        <section className="data-card empty-state">尚未导入订阅</section>
      )}
      <section className="data-card">
        <h2>订阅库状态</h2>
        <dl className="detail-list">
          <div>
            <dt>数据源</dt>
            <dd>{catalog.source}</dd>
          </div>
          <div>
            <dt>最后读取</dt>
            <dd>
              {new Date(catalog.updatedAt).toLocaleString("zh-CN", {
                hour12: false,
              })}
            </dd>
          </div>
          <div>
            <dt>节点总数</dt>
            <dd>{catalog.nodes.length}</dd>
          </div>
          <div>
            <dt>国家/地区</dt>
            <dd>{catalog.countries.length}</dd>
          </div>
        </dl>
      </section>
      {editing && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) setEditing(null);
          }}
        >
          <form
            className="confirm-dialog subscription-settings-modal"
            onSubmit={saveSettings}
          >
            <div className="subscription-settings-head">
              <div>
                <span className="eyebrow">SUBSCRIPTION SETTINGS</span>
                <h2>修改订阅设置</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setEditing(null)}
                aria-label="关闭"
              >
                <Icon name="close" />
              </button>
            </div>
            <div className="subscription-settings-grid">
              <label>
                <span>订阅名称</span>
                <input
                  required
                  value={editing.name}
                  onChange={(event) =>
                    setEditing({ ...editing, name: event.target.value })
                  }
                />
              </label>
              <label>
                <span>优先级（越大越靠前）</span>
                <input
                  required
                  type="number"
                  min="-10000"
                  max="10000"
                  value={editing.priority}
                  onChange={(event) =>
                    setEditing({ ...editing, priority: event.target.value })
                  }
                />
              </label>
              <label>
                <span>刷新周期</span>
                <Select
                  value={String(editing.refreshIntervalSeconds)}
                  onChange={(value) =>
                    setEditing({
                      ...editing,
                      refreshIntervalSeconds: Number(value),
                    })
                  }
                >
                  <option value="900">15 分钟</option>
                  <option value="3600">1 小时</option>
                  <option value="21600">6 小时</option>
                  <option value="86400">24 小时</option>
                  <option value="604800">7 天</option>
                </Select>
              </label>
              <label className="subscription-toggle">
                <span>
                  <strong>启用订阅</strong>
                  <small>停用后不再参与目录和定时刷新</small>
                </span>
                <input
                  type="checkbox"
                  checked={editing.enabled}
                  onChange={(event) =>
                    setEditing({ ...editing, enabled: event.target.checked })
                  }
                />
              </label>
              {editing.sourceType === "url" && (
                <label className="wide">
                  <span>替换远程 URL（留空保持不变）</span>
                  <input
                    type="url"
                    value={editing.url}
                    onChange={(event) =>
                      setEditing({ ...editing, url: event.target.value })
                    }
                    placeholder={editing.maskedUrl || "https://…"}
                  />
                </label>
              )}
            </div>
            <div className="dialog-actions">
              <button
                type="button"
                className="button ghost"
                disabled={Boolean(busy)}
                onClick={() => setEditing(null)}
              >
                取消
              </button>
              <button className="button primary" disabled={Boolean(busy)}>
                {busy === `edit-${editing.id}` ? "保存中…" : "保存设置"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [authenticated, setAuthenticated] = useState(null),
    { loading, catalog, runtime, error, refresh } = useCatalog(
      authenticated === true,
    ),
    [active, setActive] = useState("overview"),
    [ports, setPorts] = useState([]),
    [initialized, setInitialized] = useState(false),
    [logs, setLogs] = useState([]),
    [refreshSeconds, setRefreshSecondsState] = useState(() =>
      Number(localStorage.getItem("ppm:refreshSeconds") || 0),
    ),
    [tick, setTick] = useState(0);
  const addLog = useCallback(
    (text) =>
      setLogs((current) =>
        [{ id: crypto.randomUUID(), at: Date.now(), text }, ...current].slice(
          0,
          100,
        ),
      ),
    [],
  );
  useEffect(() => {
    if (!catalog) return;
    const listeners = catalog.listeners || [],
      restored = dedupePortsByPort(listeners);
    setPorts(restored);
    setInitialized(true);
    addLog(
      `${initialized ? "刷新" : "读取"} ${catalog.providers.length} 个订阅、${catalog.nodes.length} 个节点、${catalog.countries.length} 个国家/地区、${listeners.length} 个服务端监听`,
    );
  }, [catalog, addLog]);
  useEffect(() => {
    if (!refreshSeconds) return;
    const id = setInterval(refresh, refreshSeconds * 1000);
    return () => clearInterval(id);
  }, [refreshSeconds, refresh]);
  useEffect(() => {
    const id = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    let live = true;
    apiFetch("/auth/session")
      .then((response) => {
        if (live) setAuthenticated(response.ok);
      })
      .catch(() => {
        if (live) setAuthenticated(false);
      });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    const logout = () => {
      setAuthenticated(false);
      setInitialized(false);
    };
    window.addEventListener("ppm:unauthorized", logout);
    return () => window.removeEventListener("ppm:unauthorized", logout);
  }, []);
  const setRefreshSeconds = (v) => {
    setRefreshSecondsState(v);
    localStorage.setItem("ppm:refreshSeconds", String(v));
    addLog(`界面自动刷新设置为 ${v ? `${v} 秒` : "关闭"}`);
  };
  const logout = async () => {
    try {
      await apiFetch("/auth/logout", { method: "POST" });
    } finally {
      setAuthenticated(false);
      setInitialized(false);
    }
  };
  if (authenticated === null)
    return (
      <div className="loading-screen">
        <span className="brand-mark">
          <i />
          <i />
          <i />
        </span>
        <strong>正在恢复登录状态…</strong>
      </div>
    );
  if (!authenticated)
    return <LoginScreen onLogin={() => setAuthenticated(true)} />;
  if (loading && !catalog)
    return (
      <div className="loading-screen">
        <span className="brand-mark">
          <i />
          <i />
          <i />
        </span>
        <strong>正在读取服务状态…</strong>
      </div>
    );
  if (error && !catalog)
    return (
      <div className="loading-screen error-screen">
        <strong>数据读取失败</strong>
        <p>{error}</p>
        <button className="button primary" onClick={refresh}>
          重试
        </button>
      </div>
    );
  const liveRuntime = {
    ...runtime,
    processUptimeSeconds: (runtime?.processUptimeSeconds || 0) + tick,
  };
  const pages = {
    overview: (
      <OverviewPage catalog={catalog} runtime={liveRuntime} ports={ports} />
    ),
    ports: (
      <PortsPage
        ports={ports}
        setPorts={setPorts}
        nodes={catalog.nodes}
        providers={catalog.providers}
        countries={catalog.countries}
        addLog={addLog}
      />
    ),
    nodes: <NodesPage catalog={catalog} />,
    observability: <ObservabilityPage />,
    subscriptions: <SubscriptionsPage catalog={catalog} refresh={refresh} />,
    logs: <LogsPage />,
    settings: (
      <SettingsPage
        runtime={liveRuntime}
        refreshSeconds={refreshSeconds}
        setRefreshSeconds={setRefreshSeconds}
        refresh={refresh}
        onRecovered={async () => {
          await refresh();
          setPorts([]);
        }}
        resetPorts={() => {
          setPorts(dedupePortsByPort(catalog.listeners || []));
          addLog("重新同步服务端端口配置");
        }}
      />
    ),
  };
  return (
    <div className="app-shell" data-app="proxy-port-manager">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <i />
            <i />
            <i />
          </span>
          <strong>代理端口管理</strong>
          <span className="version">CONFIG / LIVE</span>
        </div>
        <div className="system-strip">
          <span>
            <i className="status-dot" />
            配置服务正常
          </span>
          <span>
            服务运行&nbsp; {formatDuration(liveRuntime.processUptimeSeconds)}
          </span>
          <span>
            订阅&nbsp; {catalog.providers.length} · 节点&nbsp;{" "}
            {catalog.nodes.length} · 国家/地区&nbsp; {catalog.countries.length}
          </span>
        </div>
        <div className="topbar-actions">
          <button className="text-button" onClick={logout}>
            退出登录
          </button>
          <button
            className="icon-button refresh"
            onClick={refresh}
            aria-label="刷新"
          >
            <Icon name="refresh" />
          </button>
        </div>
      </header>
      <aside className="sidebar">
        <nav>
          {NAV_ITEMS.map(([id, label, icon]) => (
            <button
              key={id}
              aria-label={label}
              className={active === id ? "active" : ""}
              onClick={() => setActive(id)}
            >
              <Icon name={icon} />
              <span>{label}</span>
              {id === "ports" && <b>{ports.length}</b>}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <UpdateCenter version={liveRuntime.appVersion} />
        </div>
      </aside>
      <main className="workspace">{pages[active]}</main>
      {error && (
        <div className="toast danger">
          <span>!</span>
          {error}
        </div>
      )}
    </div>
  );
}
