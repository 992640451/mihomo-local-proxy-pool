import { useCallback, useEffect, useState } from 'react';
import { apiErrorMessage, apiFetch } from '../api.js';

export async function observationRequest(path, options = {}) {
  const response = await apiFetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const payload = await response.json();
  if (!response.ok) throw new Error(apiErrorMessage(payload));
  return payload;
}

export function useObservability() {
  const [data, setData] = useState(null), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    let stopped = false, timer;
    const abort = new AbortController();
    const poll = async () => {
      try {
        if (!document.hidden) {
          const result = await observationRequest('/observability', { signal: abort.signal });
          if (!stopped) { setData(result); setError(''); }
        }
      } catch (cause) { if (!stopped) setError(cause.message); }
      finally { if (!stopped) timer = setTimeout(poll, 5000); }
    };
    poll();
    return () => { stopped = true; abort.abort(); clearTimeout(timer); };
  }, [revision]);
  return { data, error, refresh };
}
