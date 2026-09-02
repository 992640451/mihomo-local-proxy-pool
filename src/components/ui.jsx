export function Icon({ name, size = 18 }) {
  const paths = {
    grid: (
      <>
        <rect x="3" y="3" width="6" height="6" rx="1" />
        <rect x="15" y="3" width="6" height="6" rx="1" />
        <rect x="3" y="15" width="6" height="6" rx="1" />
        <rect x="15" y="15" width="6" height="6" rx="1" />
      </>
    ),
    server: (
      <>
        <rect x="3" y="4" width="18" height="6" rx="2" />
        <rect x="3" y="14" width="18" height="6" rx="2" />
        <path d="M7 7h.01M7 17h.01M11 7h6M11 17h6" />
      </>
    ),
    nodes: (
      <>
        <circle cx="12" cy="5" r="2.5" />
        <circle cx="5" cy="18" r="2.5" />
        <circle cx="19" cy="18" r="2.5" />
        <path d="m10.4 7-4 8.5M13.6 7l4 8.5M7.5 18h9" />
      </>
    ),
    file: (
      <>
        <path d="M6 2h9l4 4v16H6z" />
        <path d="M14 2v5h5M9 12h6M9 16h6" />
      </>
    ),
    clipboard: (
      <>
        <path d="M9 5H6a2 2 0 0 0-2 2v14h16V7a2 2 0 0 0-2-2h-3" />
        <rect x="9" y="2" width="6" height="5" rx="1" />
        <path d="M8 12h8M8 16h6" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l-2.83 2.83A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1.4 1.7h-4A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-2.83-2.83A1.7 1.7 0 0 0 4.6 15 1.7 1.7 0 0 0 2.9 13.6v-4A1.7 1.7 0 0 0 4.6 8.5a1.7 1.7 0 0 0-.34-1.88l2.83-2.83A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10.4 3h4A1.7 1.7 0 0 0 15.5 4.6a1.7 1.7 0 0 0 1.88-.34l2.83 2.83A1.7 1.7 0 0 0 19.4 9c.15.38.6.6 1.7.6v4c-1.1 0-1.55.22-1.7.6Z" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    search: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-4-4" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 11a8 8 0 1 0-2.3 5.7" />
        <path d="M20 4v7h-7" />
      </>
    ),
    close: <path d="m5 5 14 14M19 5 5 19" />,
    activity: <path d="M3 12h4l2.5-7 5 14 2.5-7h4" />,
    trash: (
      <>
        <path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
  };
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}

export function Select({ value, onChange, children, ariaLabel }) {
  return (
    <label className="select-wrap">
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={ariaLabel}
      >
        {children}
      </select>
      <span className="select-arrow">⌄</span>
    </label>
  );
}

export function PageHead({ eyebrow, title, description, action }) {
  return (
    <div className="page-head">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}

export function MetricCard({ label, value, suffix, meta, icon, tone = "cyan" }) {
  return (
    <article className={`metric-card tone-${tone}`}>
      <div className="metric-head">
        <span>{label}</span>
        <span className="metric-status" />
      </div>
      <div className="metric-body">
        <div>
          <strong>{value}</strong>
          {suffix && <span className="metric-suffix">{suffix}</span>}
        </div>
        <div className="metric-icon">
          <Icon name={icon} size={31} />
        </div>
      </div>
      <div className="metric-meta">{meta}</div>
    </article>
  );
}

export function formatDuration(seconds = 0) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return `${days ? `${days}天 ` : ""}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}
