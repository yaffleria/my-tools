import {
  BridgeError,
  READY_EVENT,
  WebViewBridge,
  type BridgeEnvelope,
  type MethodDef,
} from '@my-tools/webview-bridge';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Log, Page } from '../components/Page';

/** The contract between this page and the app. In a real project this lives in one shared file. */
type WebToApp = {
  'storage.get': MethodDef<{ key: string }, { value: string | null }>;
  'device.vibrate': MethodDef<{ ms: number }, void>;
};
type Events = {
  'theme.changed': { mode: 'light' | 'dark' };
};
type AppToWeb = {
  'auth.token': MethodDef<void, { token: string }>;
};

type Line = { id: number; text: string; tone?: string };
let seq = 0;

/**
 * A fake native app. It receives what the page posts (through an injected transport)
 * and answers the way the README asks native code to: queue until `bridge.ready`,
 * reply to every request with the same id, never reply to events.
 */
class FakeApp {
  queueUntilReady = true;
  #ready = false;
  #outbox: BridgeEnvelope[] = [];
  deliverToWeb: ((envelope: BridgeEnvelope) => void) | null = null;
  constructor(private log: (text: string, tone?: string) => void) {}

  /** Page started loading: wait for a fresh ready signal. */
  pageWillLoad() {
    this.#ready = false;
  }

  /** Page → app. */
  receive(envelope: BridgeEnvelope) {
    this.log(`웹 → 앱  ${envelope.kind} ${envelope.name}${show(envelope.payload ?? envelope.error)}`, envelope.error ? 'error' : 'out');
    if (envelope.kind === 'event' && envelope.name === READY_EVENT) {
      this.#ready = true;
      const queued = this.#outbox.splice(0);
      if (queued.length) this.log(`앱: 준비 신호 받음 → 쌓아 둔 ${queued.length}건 전송`, 'info');
      queued.forEach((item) => this.#send(item));
      return;
    }
    if (envelope.kind !== 'request') return;

    // Fake native work with a little latency.
    setTimeout(() => {
      if (envelope.name === 'storage.get') {
        this.reply(envelope, { value: 'ko' });
      } else if (envelope.name === 'device.vibrate') {
        this.log('앱: (일부러 응답하지 않음 → 웹에서 TIMEOUT)', 'warn');
      } else {
        this.reply(envelope, undefined, { code: 'METHOD_NOT_FOUND', message: `No handler for ${envelope.name}` });
      }
    }, 300);
  }

  reply(request: BridgeEnvelope, payload?: unknown, error?: { code: string; message: string }) {
    // Responses skip the queue: the page is already listening because it sent the request.
    this.#send({ version: 1, id: request.id, kind: 'response', name: request.name, ...(error ? { error } : { payload }) });
  }

  /** App → page, app-initiated (event or request). These wait for the ready signal. */
  sendFromApp(envelope: BridgeEnvelope) {
    if (this.queueUntilReady && !this.#ready) {
      this.#outbox.push(envelope);
      this.log(`앱: 웹이 아직 준비 전 → 큐에 보관 (${this.#outbox.length}건)`, 'info');
      return;
    }
    this.#send(envelope);
  }

  #send(envelope: BridgeEnvelope) {
    if (!this.deliverToWeb) {
      this.log(`앱 → 웹  ${envelope.kind} ${envelope.name}  ✗ 받을 페이지가 없음 → 유실`, 'error');
      return;
    }
    this.log(`앱 → 웹  ${envelope.kind} ${envelope.name}${show(envelope.payload ?? envelope.error)}`, 'in');
    this.deliverToWeb(envelope);
  }
}

function show(value: unknown) {
  return value === undefined ? '' : `  ${JSON.stringify(value)}`;
}

export function BridgePage() {
  const [lines, setLines] = useState<Line[]>([]);
  const [mode, setMode] = useState<'light' | 'dark'>('light');
  const [queue, setQueue] = useState(true);
  const [loaded, setLoaded] = useState(true);
  const log = useCallback((text: string, tone?: string) => {
    setLines((prev) => [...prev.slice(-60), { id: ++seq, text, tone }]);
  }, []);

  const appRef = useRef<FakeApp | null>(null);
  if (!appRef.current) appRef.current = new FakeApp(log);
  const app = appRef.current;
  app.queueUntilReady = queue;

  const bridgeRef = useRef<WebViewBridge<WebToApp, Events, AppToWeb> | null>(null);

  // The page side: exactly what you would write in a real WebView page.
  useEffect(() => {
    if (!loaded) return;
    const bridge = new WebViewBridge<WebToApp, Events, AppToWeb>({
      listen: false,
      transport: { name: 'fake-app', post: (envelope) => app.receive(envelope) },
    });
    app.deliverToWeb = (envelope) => bridge.receive(envelope);

    const off = bridge.on('theme.changed', ({ mode: next }) => {
      setMode(next);
      log(`웹: theme.changed 처리 → ${next}`, 'ok');
    });
    bridge.handle('auth.token', () => ({ token: 'demo-token-123' }));
    bridgeRef.current = bridge;
    bridge.announceReady(); // after on/handle

    return () => {
      off();
      bridge.destroy();
      bridgeRef.current = null;
      app.deliverToWeb = null;
    };
  }, [loaded, app, log]);

  const reportError = (name: string, error: unknown) => {
    if (error instanceof BridgeError) log(`웹: ${name} 실패 → ${error.code}`, 'error');
    else throw error;
  };

  const getLang = async () => {
    try {
      const { value } = await bridgeRef.current!.request('storage.get', { key: 'lang' });
      log(`웹: storage.get 결과 value=${value}`, 'ok');
    } catch (error) {
      reportError('storage.get', error);
    }
  };

  const vibrate = async () => {
    try {
      await bridgeRef.current!.request('device.vibrate', { ms: 50 }, { timeout: 1500 });
    } catch (error) {
      reportError('device.vibrate', error);
    }
  };

  const reload = () => {
    log('— 페이지 다시 로드 시작 (1.5초 동안 페이지 스크립트 없음) —', 'info');
    app.pageWillLoad();
    setLoaded(false);
    setTimeout(() => setLoaded(true), 1500);
  };

  return (
    <Page
      title="WebView 브리지"
      summary="웹과 앱이 하나의 봉투(envelope) 형식으로 요청·응답·이벤트를 주고받습니다. 여기서는 '가짜 앱'이 앱 역할을 합니다."
      points={[
        '모든 메시지는 { version, id, kind, name, payload?, error? } 하나의 형식이다.',
        'request는 같은 id의 response로 짝지어지고, 응답이 없으면 TIMEOUT으로 끝난다.',
        '웹은 on/handle 등록 후 announceReady()로 bridge.ready를 보낸다. 앱은 그 전까지 보낼 메시지를 큐에 쌓는다.',
        '"페이지 다시 로드" 중에 앱이 이벤트를 보내 보세요. 큐를 끄면 유실되고, 켜면 로드가 끝난 뒤 전달된다.',
        '웹 요청에 대한 응답은 큐를 거치지 않는다. 웹은 생성 시점부터 듣고 있기 때문이다.',
      ]}
      source={[
        { label: '브리지 본체', path: 'packages/webview-bridge/src/index.ts' },
        { label: '프로토콜·네이티브 예시', path: 'packages/webview-bridge/README.md' },
        { label: '이 페이지 (가짜 앱 포함)', path: 'apps/web/src/pages/BridgePage.tsx' },
      ]}
    >
      <div className="split">
        <div className="stack">
          <h3>웹 (WebView 안 페이지)</h3>
          <p className="muted">
            상태: {loaded ? '로드됨' : '로드 중…'} · 테마 <code>{mode}</code>
          </p>
          <button type="button" disabled={!loaded} onClick={getLang}>
            request storage.get
          </button>
          <button type="button" disabled={!loaded} onClick={vibrate}>
            응답 없는 request (1.5초 timeout)
          </button>
          <button type="button" onClick={reload} disabled={!loaded}>
            페이지 다시 로드
          </button>
        </div>
        <div className="stack">
          <h3>가짜 앱 (네이티브)</h3>
          <label className="check">
            <input type="checkbox" checked={queue} onChange={(event) => setQueue(event.target.checked)} />
            bridge.ready 전까지 큐에 쌓기
          </label>
          <button
            type="button"
            onClick={() =>
              app.sendFromApp({
                version: 1,
                id: crypto.randomUUID(),
                kind: 'event',
                name: 'theme.changed',
                payload: { mode: mode === 'light' ? 'dark' : 'light' },
              })
            }
          >
            event theme.changed
          </button>
          <button
            type="button"
            onClick={() => app.sendFromApp({ version: 1, id: crypto.randomUUID(), kind: 'request', name: 'auth.token' })}
          >
            request auth.token
          </button>
          <button
            type="button"
            onClick={() => app.sendFromApp({ version: 1, id: crypto.randomUUID(), kind: 'request', name: 'unknown.method' })}
          >
            모르는 메서드 request
          </button>
        </div>
      </div>
      <div className="row">
        <h3>메시지 기록</h3>
        <button type="button" className="small" onClick={() => setLines([])}>
          지우기
        </button>
      </div>
      <Log lines={lines} />
    </Page>
  );
}
