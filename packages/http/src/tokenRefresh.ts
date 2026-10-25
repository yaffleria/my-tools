import type { AxiosError, AxiosInstance, InternalAxiosRequestConfig } from 'axios';

/**
 * Access-token refresh for an axios instance.
 *
 * What it guarantees:
 * 1. Concurrent 401s trigger exactly one `refresh()`. The others wait for that
 *    same promise, then retry with the new token.
 * 2. A request is retried at most once. A retry that 401s again fails instead of
 *    looping refresh → 401 → refresh.
 * 3. If refresh fails, every waiting request fails with that error and
 *    `onRefreshFailed` runs once (logout goes there).
 * 4. A 401 for a request that was sent with an older token (the refresh already
 *    happened while it was in flight) retries with the current token without
 *    refreshing again.
 *
 * ```ts
 * const api = axios.create({ baseURL: '/api' });
 * attachTokenRefresh(api, {
 *   refresh: () => axios.post('/api/auth/refresh').then((r) => r.data.accessToken),
 *   onTokenRefreshed: (token) => tokenStore.set(token),
 *   onRefreshFailed: () => { tokenStore.clear(); location.href = '/login'; },
 * });
 * ```
 *
 * `refresh` must NOT use the same instance (`api`): its 401 would come back into
 * this interceptor and wait for itself.
 */

export interface TokenRefreshOptions {
  /** Gets a new access token. Use plain `axios` or a separate instance. */
  refresh: () => Promise<string>;
  /** Store the new token (memory, store, …). Runs before waiting requests retry. */
  onTokenRefreshed?: (token: string) => void;
  /** Refresh failed: clear the session and go to login. Runs once per failed refresh. */
  onRefreshFailed?: (error: unknown) => void;
  /** Which failures mean "token expired". Default: HTTP 401. */
  shouldRefresh?: (error: AxiosError) => boolean;
  /** How the token goes on the retried request. Default: `Authorization: Bearer <token>`. */
  applyToken?: (config: InternalAxiosRequestConfig, token: string) => void;
}

// String keys, not symbols: axios copies a config's own string keys when it
// re-runs a request, so these survive `client(config)`.
type TrackedConfig = InternalAxiosRequestConfig & {
  /** Already retried once after a refresh. */
  __myToolsRetried?: boolean;
  /** How many refreshes had finished when this request was sent. */
  __myToolsTokenGen?: number;
};

const is401 = (error: AxiosError) => error.response?.status === 401;

const bearer = (config: InternalAxiosRequestConfig, token: string) => {
  config.headers.setAuthorization(`Bearer ${token}`);
};

/**
 * Adds the refresh interceptors to `client`.
 * Returns a function that removes them (tests, HMR, logout-and-recreate).
 */
export function attachTokenRefresh(client: AxiosInstance, options: TokenRefreshOptions): () => void {
  const { refresh, onTokenRefreshed, onRefreshFailed, shouldRefresh = is401, applyToken = bearer } = options;

  /** The refresh in progress. Everyone who hits a 401 meanwhile awaits this same promise. */
  let pending: Promise<string> | null = null;
  /** Finished refreshes. Lets us tell a "stale token" 401 from a real expiry. */
  let generation = 0;
  let latestToken: string | null = null;

  const getFreshToken = (): Promise<string> => {
    // Assigned synchronously, before any await: a 401 that arrives one tick later
    // already sees `pending` and joins it instead of starting a second refresh.
    pending ??= refresh()
      .then((token) => {
        generation += 1;
        latestToken = token;
        onTokenRefreshed?.(token);
        return token;
      })
      .catch((error: unknown) => {
        onRefreshFailed?.(error);
        throw error;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };

  const requestId = client.interceptors.request.use((config: TrackedConfig) => {
    config.__myToolsTokenGen ??= generation;
    return config;
  });

  const responseId = client.interceptors.response.use(undefined, async (error: unknown) => {
    if (!isAxiosError(error) || !shouldRefresh(error)) throw error;

    const config = error.config as TrackedConfig | undefined;
    if (!config || config.__myToolsRetried) throw error;
    config.__myToolsRetried = true;

    const sentWithOldToken = latestToken !== null && (config.__myToolsTokenGen ?? 0) < generation;
    const token = sentWithOldToken && latestToken !== null ? latestToken : await getFreshToken();

    applyToken(config, token);
    config.__myToolsTokenGen = generation;
    return client(config);
  });

  return () => {
    client.interceptors.request.eject(requestId);
    client.interceptors.response.eject(responseId);
  };
}

/** Same check as `axios.isAxiosError`, without importing axios at runtime. */
function isAxiosError(error: unknown): error is AxiosError {
  return typeof error === 'object' && error !== null && (error as { isAxiosError?: unknown }).isAxiosError === true;
}
