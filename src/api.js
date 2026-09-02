const API_BASE = `${import.meta.env.BASE_URL}api`;

export async function apiFetch(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  if (
    response.status === 401 &&
    !["/auth/login", "/auth/session", "/auth/logout"].includes(path)
  )
    window.dispatchEvent(new Event("ppm:unauthorized"));
  return response;
}

export function apiErrorMessage(payload, fallback = "操作失败") {
  if (typeof payload?.error === "string") return payload.detail || payload.error;
  return payload?.error?.detail || payload?.error?.message || fallback;
}
