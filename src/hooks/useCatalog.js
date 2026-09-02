import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../api.js";

export function useCatalog(enabled) {
  const [state, setState] = useState({
    loading: true,
    catalog: null,
    runtime: null,
    error: "",
  });
  const refresh = useCallback(async () => {
    if (!enabled) return;
    setState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const [catalogResponse, runtimeResponse] = await Promise.all([
        apiFetch("/subscriptions/catalog"),
        apiFetch("/runtime"),
      ]);
      if (!catalogResponse.ok || !runtimeResponse.ok) throw new Error("后端接口返回异常");
      setState({
        loading: false,
        catalog: await catalogResponse.json(),
        runtime: await runtimeResponse.json(),
        error: "",
      });
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error.message }));
    }
  }, [enabled]);
  useEffect(() => {
    if (enabled) refresh();
  }, [enabled, refresh]);
  return { ...state, refresh };
}
