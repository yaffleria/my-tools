import type { AxiosInstance, AxiosResponse, InternalAxiosRequestConfig } from 'axios';

/**
 * Hybrid request encryption with Web Crypto (no libraries).
 *
 * Why hybrid: anything shipped to the browser (env vars included) is public, so
 * there is no secret key on the client. Each request gets a fresh AES-256-GCM key
 * that encrypts the body; that AES key is wrapped with the server's RSA-OAEP
 * public key, which only the server's private key can unwrap. The server encrypts
 * its response with the same AES key, so the response is readable only by the
 * client that sent the request.
 *
 * Wire format (the server must implement the same):
 *
 * request body  { key, iv, data }   all base64
 *   key  = RSA-OAEP(SHA-256)(server public key, raw AES key)
 *   iv   = 12 random bytes
 *   data = AES-GCM(aesKey, iv, JSON.stringify({ nonce, ts, body }))
 *
 * response body { iv, data }        all base64
 *   data = AES-GCM(same aesKey, new iv, JSON.stringify(responseBody))
 *
 * `nonce` (UUID) and `ts` (ms) let the server reject replays.
 */

export interface EncryptedRequest {
  key: string;
  iv: string;
  data: string;
}

export interface EncryptedResponse {
  iv: string;
  data: string;
}

export interface HybridEncryptor {
  /** Encrypts `body` with a fresh AES key. Keep `aesKey` to decrypt the response. */
  encrypt(body: unknown): Promise<{ payload: EncryptedRequest; aesKey: CryptoKey }>;
  /** Decrypts a response encrypted with the request's AES key. */
  decrypt(aesKey: CryptoKey, response: EncryptedResponse): Promise<unknown>;
}

export interface HybridEncryptorOptions {
  /**
   * Returns the server's RSA-OAEP public key. Called on every encrypt, so cache
   * inside (see `cachedPublicKey`). Fetching it from the server is fine: a public
   * key is not a secret.
   */
  getPublicKey: () => Promise<CryptoKey>;
}

const RSA = { name: 'RSA-OAEP', hash: 'SHA-256' } as const;

export function createHybridEncryptor({ getPublicKey }: HybridEncryptorOptions): HybridEncryptor {
  return {
    async encrypt(body) {
      const aesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plain = JSON.stringify({ nonce: crypto.randomUUID(), ts: Date.now(), body });

      const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, new TextEncoder().encode(plain));
      const rawKey = await crypto.subtle.exportKey('raw', aesKey);
      const key = await crypto.subtle.encrypt(RSA, await getPublicKey(), rawKey);

      return {
        payload: { key: bytesToBase64(key), iv: bytesToBase64(iv), data: bytesToBase64(data) },
        aesKey,
      };
    },

    async decrypt(aesKey, response) {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToBytes(response.iv) },
        aesKey,
        base64ToBytes(response.data),
      );
      // External data: unknown until the caller validates it.
      return JSON.parse(new TextDecoder().decode(plain)) as unknown;
    },
  };
}

/** Imports a base64 SPKI (what most servers export) as an RSA-OAEP encryption key. */
export function importRsaPublicKey(spkiBase64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('spki', base64ToBytes(spkiBase64), RSA, false, ['encrypt']);
}

/**
 * Wraps a key loader so it runs once. A failed load is not cached, so the next
 * request tries again.
 *
 * ```ts
 * getPublicKey: cachedPublicKey(() =>
 *   axios.get('/api/crypto/public-key').then((r) => importRsaPublicKey(r.data.spki)),
 * )
 * ```
 */
export function cachedPublicKey(load: () => Promise<CryptoKey>): () => Promise<CryptoKey> {
  let cached: Promise<CryptoKey> | null = null;
  return () => {
    cached ??= load().catch((error: unknown) => {
      cached = null;
      throw error;
    });
    return cached;
  };
}

export interface EncryptionOptions {
  /** Which requests to encrypt. Default: every request that has a body. */
  shouldEncrypt?: (config: InternalAxiosRequestConfig) => boolean;
}

type EncryptedConfig = InternalAxiosRequestConfig & {
  /** The original body. A retry re-encrypts from this, never resends old ciphertext. */
  __myToolsPlainBody?: unknown;
  __myToolsAesKey?: CryptoKey;
};

/**
 * Encrypts request bodies and decrypts responses on `client`.
 * Callers keep writing `api.post('/reservations', input)` and get plain `data` back.
 *
 * Works with `attachTokenRefresh` in either order: a retried request is encrypted
 * again from the original body with a new AES key, IV and nonce, and a response
 * is never decrypted twice.
 *
 * Returns a function that removes the interceptors.
 */
export function attachEncryption(
  client: AxiosInstance,
  encryptor: HybridEncryptor,
  { shouldEncrypt = (config) => config.data !== undefined }: EncryptionOptions = {},
): () => void {
  // Responses already decrypted (the inner call of a retry passes through the
  // outer chain again).
  const decrypted = new WeakSet<AxiosResponse>();

  const requestId = client.interceptors.request.use(async (config: EncryptedConfig) => {
    if (!('__myToolsPlainBody' in config)) {
      if (!shouldEncrypt(config)) return config;
      config.__myToolsPlainBody = config.data;
    }
    const { payload, aesKey } = await encryptor.encrypt(config.__myToolsPlainBody);
    config.__myToolsAesKey = aesKey;
    config.data = payload;
    return config;
  });

  const responseId = client.interceptors.response.use(async (response) => {
    const aesKey = (response.config as EncryptedConfig).__myToolsAesKey;
    if (!aesKey || decrypted.has(response) || !isEncryptedResponse(response.data)) return response;
    response.data = await encryptor.decrypt(aesKey, response.data);
    decrypted.add(response);
    return response;
  });

  return () => {
    client.interceptors.request.eject(requestId);
    client.interceptors.response.eject(responseId);
  };
}

function isEncryptedResponse(value: unknown): value is EncryptedResponse {
  if (typeof value !== 'object' || value === null) return false;
  const { iv, data } = value as Record<string, unknown>;
  return typeof iv === 'string' && typeof data === 'string';
}

export function bytesToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}
