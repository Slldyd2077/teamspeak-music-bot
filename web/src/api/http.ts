import router from '../router/index.js';
import { useSession } from '../composables/useSession.js';

let installed = false;

/**
 * Wraps fetch so every call:
 *   - sends cookies (`credentials: 'same-origin'`)
 *   - on 401 from /api/*: clear local session, redirect to /login
 */
export function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const merged: RequestInit = {
    credentials: 'same-origin',
    ...init,
    headers: { ...(init.headers ?? {}) },
  };
  return fetch(input, merged).then(async (res) => {
    if (res.status === 401 && isApiPath(input)) {
      const session = useSession();
      await session.refresh();
      const current = router.currentRoute.value;
      if (current.name !== 'login' && current.name !== 'first-run') {
        await router.replace({ name: 'login', query: { next: current.fullPath } });
      }
    }
    return res;
  });
}

function isApiPath(input: RequestInfo | URL): boolean {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  return url.startsWith('/api/');
}

/**
 * Replaces window.fetch with apiFetch so existing call sites do not need to be touched.
 * Call once at app startup.
 */
export function installApiClient(): void {
  if (installed) return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    return apiFetch(input, init ?? {});
  }) as typeof window.fetch;
  // Keep original accessible if anything needs to bypass
  (window as unknown as { __originalFetch?: typeof fetch }).__originalFetch = original;
}
