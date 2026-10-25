import axios, { AxiosError, AxiosHeaders, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { attachTokenRefresh } from './tokenRefresh';

const ok = (config: InternalAxiosRequestConfig, data: unknown): AxiosResponse => ({
  data,
  status: 200,
  statusText: 'OK',
  headers: new AxiosHeaders(),
  config,
});

const unauthorized = (config: InternalAxiosRequestConfig) =>
  Promise.reject(
    new AxiosError('Unauthorized', AxiosError.ERR_BAD_REQUEST, config, null, {
      ...ok(config, { message: 'expired' }),
      status: 401,
      statusText: 'Unauthorized',
    }),
  );

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fake API that accepts only `Bearer <valid>`. */
function setup(valid: { token: string }, adapterDelay = 0) {
  const adapter: AxiosAdapter = async (config) => {
    await delay(adapterDelay);
    if (String(config.headers.Authorization) !== `Bearer ${valid.token}`) return unauthorized(config);
    return ok(config, { url: config.url });
  };
  return axios.create({ adapter, headers: { Authorization: 'Bearer expired' } });
}

describe('attachTokenRefresh', () => {
  it('refreshes once for concurrent 401s and retries all of them', async () => {
    const client = setup({ token: 'fresh' });
    const refresh = vi.fn(async () => {
      await delay(10);
      return 'fresh';
    });
    const onTokenRefreshed = vi.fn();
    attachTokenRefresh(client, { refresh, onTokenRefreshed });

    const results = await Promise.all(['/a', '/b', '/c'].map((url) => client.get(url)));

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onTokenRefreshed).toHaveBeenCalledWith('fresh');
    expect(results.map((r) => r.data)).toEqual([{ url: '/a' }, { url: '/b' }, { url: '/c' }]);
  });

  it('fails every waiting request and calls onRefreshFailed once when refresh fails', async () => {
    const client = setup({ token: 'fresh' });
    const refreshError = new Error('refresh failed');
    const refresh = vi.fn(async () => {
      await delay(10);
      throw refreshError;
    });
    const onRefreshFailed = vi.fn();
    attachTokenRefresh(client, { refresh, onRefreshFailed });

    const settled = await Promise.allSettled(['/a', '/b', '/c'].map((url) => client.get(url)));

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onRefreshFailed).toHaveBeenCalledTimes(1);
    expect(onRefreshFailed).toHaveBeenCalledWith(refreshError);
    expect(settled.every((s) => s.status === 'rejected' && s.reason === refreshError)).toBe(true);
  });

  it('does not loop when the retry is also 401', async () => {
    const client = setup({ token: 'never-valid' });
    const refresh = vi.fn(async () => 'fresh');
    attachTokenRefresh(client, { refresh });

    const error = await client.get('/a').catch((e: unknown) => e);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(axios.isAxiosError(error) && error.response?.status).toBe(401);
  });

  it('retries a stale-token 401 with the current token without refreshing again', async () => {
    const valid = { token: 'expired' };
    const client = setup(valid, 0);
    const refresh = vi.fn(async () => 'fresh');
    attachTokenRefresh(client, { refresh });

    // A slow request sent with the old token, still in flight while the token rotates.
    const slow = client.get('/slow', {
      adapter: async (config) => {
        await delay(30);
        return String(config.headers.Authorization) === `Bearer ${valid.token}` ? ok(config, 'slow ok') : unauthorized(config);
      },
    });
    await delay(5);
    valid.token = 'fresh'; // server rotates; the next request 401s and refreshes
    await client.get('/a');
    expect(refresh).toHaveBeenCalledTimes(1);

    await expect(slow).resolves.toMatchObject({ data: 'slow ok' });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('starts a new refresh after the previous one finished', async () => {
    const valid = { token: 'one' };
    const client = setup(valid);
    let n = 0;
    const refresh = vi.fn(async () => (valid.token = `token-${++n}`));
    attachTokenRefresh(client, { refresh });

    await client.get('/a');
    expect(refresh).toHaveBeenCalledTimes(1);

    valid.token = 'revoked-on-server';
    // Sent with the latest token (token-1), still 401: a real expiry, so refresh again.
    const response = await client.get('/b', { headers: { Authorization: 'Bearer token-1' } });

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(response.data).toEqual({ url: '/b' });
  });

  it('leaves non-401 errors alone and can be detached', async () => {
    const adapter: AxiosAdapter = (config) =>
      Promise.reject(new AxiosError('boom', AxiosError.ERR_BAD_RESPONSE, config, null, { ...ok(config, null), status: 500 }));
    const client = axios.create({ adapter });
    const refresh = vi.fn(async () => 'x');
    const detach = attachTokenRefresh(client, { refresh });

    await expect(client.get('/a')).rejects.toMatchObject({ response: { status: 500 } });
    detach();
    await expect(client.get('/a')).rejects.toBeDefined();
    expect(refresh).not.toHaveBeenCalled();
  });
});
