import axios, { AxiosError, AxiosHeaders, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  attachEncryption,
  base64ToBytes,
  bytesToBase64,
  cachedPublicKey,
  createHybridEncryptor,
  importRsaPublicKey,
  type EncryptedRequest,
} from './encryption';
import { attachTokenRefresh } from './tokenRefresh';

let keys: CryptoKeyPair;

beforeAll(async () => {
  keys = await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt'],
  );
});

/** What a server does: unwrap the AES key with its private key, decrypt, answer encrypted. */
async function serverDecrypt(payload: EncryptedRequest) {
  const raw = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, keys.privateKey, base64ToBytes(payload.key));
  const aesKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(payload.iv) }, aesKey, base64ToBytes(payload.data));
  return { aesKey, message: JSON.parse(new TextDecoder().decode(plain)) as { nonce: string; ts: number; body: unknown } };
}

async function serverEncrypt(aesKey: CryptoKey, body: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, new TextEncoder().encode(JSON.stringify(body)));
  return { iv: bytesToBase64(iv), data: bytesToBase64(data) };
}

const ok = (config: InternalAxiosRequestConfig, data: unknown): AxiosResponse => ({
  data,
  status: 200,
  statusText: 'OK',
  headers: new AxiosHeaders(),
  config,
});

const parseBody = (config: InternalAxiosRequestConfig) =>
  (typeof config.data === 'string' ? JSON.parse(config.data) : config.data) as EncryptedRequest;

describe('createHybridEncryptor', () => {
  it('round-trips with a server that holds the private key', async () => {
    const encryptor = createHybridEncryptor({ getPublicKey: async () => keys.publicKey });
    const { payload, aesKey } = await encryptor.encrypt({ roomId: 'r1' });

    const { aesKey: serverKey, message } = await serverDecrypt(payload);
    expect(message.body).toEqual({ roomId: 'r1' });
    expect(message.nonce).toMatch(/[0-9a-f-]{36}/);

    expect(await encryptor.decrypt(aesKey, await serverEncrypt(serverKey, { ok: true }))).toEqual({ ok: true });
  });

  it('imports a base64 SPKI public key', async () => {
    const spki = bytesToBase64(await crypto.subtle.exportKey('spki', keys.publicKey));
    const encryptor = createHybridEncryptor({ getPublicKey: () => importRsaPublicKey(spki) });
    const { payload } = await encryptor.encrypt('hi');
    expect((await serverDecrypt(payload)).message.body).toBe('hi');
  });
});

describe('cachedPublicKey', () => {
  it('loads once, and retries after a failure', async () => {
    const load = vi.fn<() => Promise<CryptoKey>>().mockRejectedValueOnce(new Error('network')).mockResolvedValue(keys.publicKey);
    const get = cachedPublicKey(load);
    await expect(get()).rejects.toThrow('network');
    await get();
    await get();
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('attachEncryption', () => {
  it('sends ciphertext and hands the caller plain response data', async () => {
    const seen: unknown[] = [];
    const adapter: AxiosAdapter = async (config) => {
      const payload = parseBody(config);
      expect(Object.keys(payload).sort()).toEqual(['data', 'iv', 'key']);
      const { aesKey, message } = await serverDecrypt(payload);
      seen.push(message.body);
      return ok(config, await serverEncrypt(aesKey, { id: 'res-1' }));
    };
    const client = axios.create({ adapter });
    attachEncryption(client, createHybridEncryptor({ getPublicKey: async () => keys.publicKey }));

    const { data } = await client.post('/reservations', { roomId: 'r1' });

    expect(seen).toEqual([{ roomId: 'r1' }]);
    expect(data).toEqual({ id: 'res-1' });
  });

  it('skips requests without a body', async () => {
    const adapter: AxiosAdapter = async (config) => ok(config, { plain: config.data === undefined });
    const client = axios.create({ adapter });
    attachEncryption(client, createHybridEncryptor({ getPublicKey: async () => keys.publicKey }));
    expect((await client.get('/me')).data).toEqual({ plain: true });
  });

  it.each(['encryption first', 'refresh first'])(
    'with token refresh (%s): re-encrypts the retry with a new key and nonce, decrypts once',
    async (order) => {
      const nonces: string[] = [];
      const ivs: string[] = [];
      const adapter: AxiosAdapter = async (config) => {
        const payload = parseBody(config);
        const { aesKey, message } = await serverDecrypt(payload);
        expect(message.body).toEqual({ roomId: 'r1' }); // never double-encrypted
        nonces.push(message.nonce);
        ivs.push(payload.iv);
        if (String(config.headers.Authorization) !== 'Bearer fresh') {
          throw new AxiosError('Unauthorized', AxiosError.ERR_BAD_REQUEST, config, null, { ...ok(config, null), status: 401 });
        }
        return ok(config, await serverEncrypt(aesKey, { id: 'res-1' }));
      };
      const client = axios.create({ adapter, headers: { Authorization: 'Bearer expired' } });
      const encryptor = createHybridEncryptor({ getPublicKey: async () => keys.publicKey });
      const refresh = async () => 'fresh';
      if (order === 'encryption first') {
        attachEncryption(client, encryptor);
        attachTokenRefresh(client, { refresh });
      } else {
        attachTokenRefresh(client, { refresh });
        attachEncryption(client, encryptor);
      }

      const { data } = await client.post('/reservations', { roomId: 'r1' });

      expect(data).toEqual({ id: 'res-1' });
      expect(nonces).toHaveLength(2);
      expect(new Set(nonces).size).toBe(2);
      expect(new Set(ivs).size).toBe(2);
    },
  );
});
