import {
  attachEncryption,
  attachTokenRefresh,
  base64ToBytes,
  bytesToBase64,
  createHybridEncryptor,
  type EncryptedRequest,
} from '@my-tools/http';
import axios, { AxiosError, AxiosHeaders, type AxiosAdapter } from 'axios';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Log, Page } from '../components/Page';

type Line = { id: number; text: string; tone?: string };
type Logger = (text: string, tone?: string) => void;
let seq = 0;

const short = (value: string) => (value.length > 24 ? `${value.slice(0, 24)}… (${value.length}자)` : value);
const supported = typeof crypto !== 'undefined' && !!crypto.subtle;

/**
 * A fake server that lives in this tab. It owns the RSA private key; the page
 * only ever sees the public key, exactly like a real deployment.
 */
async function createServer(log: Logger) {
  const keys = await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    false,
    ['encrypt', 'decrypt'],
  );
  const seenNonces = new Set<string>();
  const state = { tokenExpired: false };

  const adapter: AxiosAdapter = async (config) => {
    const respond = (status: number, data: unknown) => {
      const response = { data, status, statusText: String(status), headers: new AxiosHeaders(), config };
      if (status < 400) return response;
      throw new AxiosError(`HTTP ${status}`, AxiosError.ERR_BAD_REQUEST, config, null, response);
    };

    const payload = JSON.parse(String(config.data)) as EncryptedRequest;
    log(`전송되는 본문: key=${short(payload.key)} iv=${payload.iv} data=${short(payload.data)}`, 'out');

    const raw = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, keys.privateKey, base64ToBytes(payload.key));
    const aesKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(payload.iv) }, aesKey, base64ToBytes(payload.data));
    const message = JSON.parse(new TextDecoder().decode(plain)) as { nonce: string; ts: number; body: unknown };
    log(`서버: 비밀키로 복호화 → ${JSON.stringify(message.body)}, nonce ${message.nonce.slice(0, 8)}…`, 'info');

    if (seenNonces.has(message.nonce)) {
      log('서버: 이미 본 nonce → 재전송으로 보고 거절', 'error');
      return respond(400, null);
    }
    seenNonces.add(message.nonce);

    if (state.tokenExpired && String(config.headers.Authorization) !== 'Bearer fresh') {
      log('서버: 토큰 만료 → 401', 'warn');
      return respond(401, null);
    }

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const body = { reservationId: `R-${Math.floor(Math.random() * 9000 + 1000)}`, status: 'confirmed' };
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, new TextEncoder().encode(JSON.stringify(body)));
    const encrypted = { iv: bytesToBase64(iv), data: bytesToBase64(data) };
    log(`서버 응답(같은 AES 키로 암호화): data=${short(encrypted.data)}`, 'in');
    return respond(200, encrypted);
  };

  return { publicKey: keys.publicKey, adapter, state };
}

type Server = Awaited<ReturnType<typeof createServer>>;

export function EncryptionPage() {
  const [lines, setLines] = useState<Line[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [roomId, setRoomId] = useState('deluxe-1203');
  const [guest, setGuest] = useState('홍길동');
  const [expired, setExpired] = useState(true);
  const serverRef = useRef<Server | null>(null);

  const log = useCallback<Logger>((text, tone) => setLines((prev) => [...prev, { id: ++seq, text, tone }]), []);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    createServer(log).then((server) => {
      if (cancelled) return;
      serverRef.current = server;
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [log]);

  const send = async () => {
    const server = serverRef.current;
    if (!server) return;
    setLines([]);
    setBusy(true);
    server.state.tokenExpired = expired;

    // In an app this is built once in api.ts.
    const api = axios.create({ adapter: server.adapter, headers: { Authorization: 'Bearer old' } });
    attachEncryption(api, createHybridEncryptor({ getPublicKey: async () => server.publicKey }));
    attachTokenRefresh(api, {
      refresh: async () => {
        log('웹: refresh → 새 토큰, 평문부터 새 키·새 nonce로 다시 암호화해 재시도', 'info');
        return 'fresh';
      },
    });

    const input = { roomId, guest };
    log(`호출: api.post('/reservations', ${JSON.stringify(input)})`, 'out');
    try {
      const { data } = await api.post('/reservations', input);
      log(`호출자가 받은 data: ${JSON.stringify(data)}`, 'ok');
    } catch (error) {
      log(`실패: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page
      title="요청 암호화 (하이브리드)"
      summary="요청 본문을 AES-GCM으로 암호화하고, 그 AES 키를 서버 공개키(RSA)로 감싸 보냅니다. 호출하는 코드는 평소처럼 api.post만 쓰고 평문 응답을 받습니다."
      points={[
        '프론트 번들의 값은 누구나 본다 → 클라이언트에 비밀키를 두지 않는다. 공개키는 노출돼도 된다.',
        '요청마다 새 AES 키·IV·nonce. 서버는 nonce로 재전송을 거른다.',
        '재시도(토큰 갱신 후)는 옛 암호문을 다시 보내지 않고 평문부터 다시 암호화한다. 로그에서 iv와 nonce가 바뀌는 걸 확인해 보세요.',
        '응답은 같은 AES 키로 암호화돼 요청한 클라이언트만 읽을 수 있다.',
        'HTTPS를 대신하지 않는다. 프록시·로그·모니터링에 평문이 남지 않게 하는 추가 계층.',
      ]}
      source={[
        { label: '구현', path: 'packages/http/src/encryption.ts' },
        { label: '테스트', path: 'packages/http/src/encryption.test.ts' },
        { label: '이 페이지', path: 'apps/web/src/pages/EncryptionPage.tsx' },
      ]}
    >
      {!supported ? (
        <p className="alert">이 브라우저(또는 HTTP 주소)에서는 Web Crypto를 쓸 수 없어요. HTTPS로 열어 주세요.</p>
      ) : (
        <div className="stack">
          <div className="row">
            <input aria-label="객실" value={roomId} onChange={(e) => setRoomId(e.target.value)} />
            <input aria-label="투숙객" value={guest} onChange={(e) => setGuest(e.target.value)} />
          </div>
          <label className="check">
            <input type="checkbox" checked={expired} onChange={(e) => setExpired(e.target.checked)} />
            토큰 만료 상태로 보내기 (refresh 후 재시도)
          </label>
          <div className="row">
            <button type="button" disabled={!ready || busy} onClick={send}>
              {ready ? '예약 요청 보내기' : '서버 키 만드는 중…'}
            </button>
          </div>
          <Log lines={lines} empty="요청을 보내면 실제로 오가는 암호문과 서버가 본 평문이 차례로 찍힙니다." />
        </div>
      )}
    </Page>
  );
}
