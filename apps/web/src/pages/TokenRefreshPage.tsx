import { attachTokenRefresh } from '@my-tools/http';
import axios, { AxiosError, AxiosHeaders, type AxiosAdapter, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import { useCallback, useState } from 'react';
import { Log, Page } from '../components/Page';

type Line = { id: number; text: string; tone?: string };
type Scenario = 'expired' | 'refresh-fails' | 'retry-401';
type Strategy = 'tool' | 'naive';
type Logger = (text: string, tone?: string) => void;

let seq = 0;
const PATHS = ['/orders', '/me', '/cart'];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fake server inside the page. Nothing goes over the network. */
function createServer(scenario: Scenario, log: Logger) {
  let validToken = 'token-1';
  let issued = 1;
  const counts = { refresh: 0 };

  const respond = (config: InternalAxiosRequestConfig, status: number, data: unknown) => {
    const response = { data, status, statusText: String(status), headers: new AxiosHeaders(), config };
    if (status < 400) return response;
    throw new AxiosError(`HTTP ${status}`, AxiosError.ERR_BAD_REQUEST, config, null, response);
  };

  const adapter: AxiosAdapter = async (config) => {
    await wait(150 + Math.random() * 250);
    if (config.url === '/auth/refresh') {
      counts.refresh += 1;
      if (scenario === 'refresh-fails') {
        log(`서버: refresh #${counts.refresh} 거절 (refresh token 만료)`, 'error');
        return respond(config, 401, null);
      }
      issued += 1;
      validToken = `token-${issued}`;
      log(`서버: refresh #${counts.refresh} → 새 토큰 ${validToken}`, 'info');
      return respond(config, 200, { accessToken: validToken });
    }
    const auth = String(config.headers.Authorization ?? '').replace('Bearer ', '');
    const accepted = scenario !== 'retry-401' && auth === validToken;
    log(`서버: ${config.url} (${auth}) → ${accepted ? 200 : 401}`, accepted ? 'in' : 'warn');
    return accepted ? respond(config, 200, { ok: true }) : respond(config, 401, null);
  };

  // The refresh call uses its own instance, never the intercepted one.
  const refresh = () => axios.post<{ accessToken: string }>('/auth/refresh', null, { adapter }).then((r) => r.data.accessToken);
  return { adapter, refresh, counts };
}

/** ❌ Common first attempt: every 401 refreshes on its own. */
function attachNaiveRefresh(client: AxiosInstance, refresh: () => Promise<string>, onFailed: () => void) {
  client.interceptors.response.use(undefined, async (error: unknown) => {
    if (!axios.isAxiosError(error) || error.response?.status !== 401 || !error.config) throw error;
    const config = error.config as InternalAxiosRequestConfig & { _retry?: boolean };
    if (config._retry) throw error;
    config._retry = true;
    try {
      config.headers.setAuthorization(`Bearer ${await refresh()}`);
    } catch (refreshError) {
      onFailed();
      throw refreshError;
    }
    return client(config);
  });
}

async function run(scenario: Scenario, strategy: Strategy, log: Logger) {
  const server = createServer(scenario, log);
  let logouts = 0;
  const onFailed = () => {
    logouts += 1;
    log(`웹: 로그아웃 처리 #${logouts}`, 'error');
  };

  const client = axios.create({ adapter: server.adapter, headers: { Authorization: 'Bearer token-1-expired' } });
  if (strategy === 'tool') {
    attachTokenRefresh(client, { refresh: server.refresh, onRefreshFailed: onFailed });
  } else {
    attachNaiveRefresh(client, server.refresh, onFailed);
  }

  log(`웹: 만료된 토큰으로 ${PATHS.join(', ')} 동시 요청`, 'out');
  const settled = await Promise.allSettled(PATHS.map((path) => client.get(path)));
  settled.forEach((result, index) =>
    log(`결과 ${PATHS[index]}: ${result.status === 'fulfilled' ? '성공' : '실패'}`, result.status === 'fulfilled' ? 'ok' : 'error'),
  );
  const good = server.counts.refresh === 1 && logouts <= 1;
  log(`요약: refresh ${server.counts.refresh}회, 로그아웃 ${logouts}회 ${good ? '✓' : '← 여러 번!'}`, good ? 'ok' : 'error');
}

const SCENARIOS: { key: Scenario; label: string; expect: string }[] = [
  { key: 'expired', label: '토큰 만료 + 3건 동시', expect: 'refresh 1회, 세 요청 모두 재시도 성공' },
  { key: 'refresh-fails', label: 'refresh도 실패', expect: 'refresh 1회, 세 요청 실패, 로그아웃 1회' },
  { key: 'retry-401', label: '재시도도 401', expect: 'refresh 1회, 무한 반복 없이 실패' },
];

export function TokenRefreshPage() {
  const [lines, setLines] = useState<Line[]>([]);
  const [strategy, setStrategy] = useState<Strategy>('tool');
  const [running, setRunning] = useState(false);

  const log = useCallback<Logger>((text, tone) => setLines((prev) => [...prev, { id: ++seq, text, tone }]), []);

  const start = (scenario: Scenario) => {
    setLines([]);
    setRunning(true);
    run(scenario, strategy, log)
      .catch((error: unknown) => log(String(error), 'error'))
      .finally(() => setRunning(false));
  };

  return (
    <Page
      title="토큰 갱신 (동시 401)"
      summary="access token이 만료된 채로 요청 여러 개가 동시에 나가면 401도 동시에 돌아옵니다. refresh는 한 번만 하고, 나머지는 그 결과를 기다렸다가 재시도해야 합니다."
      points={[
        '큐 = 진행 중인 refresh Promise 하나. 401이 나면 그 Promise를 같이 await하고, 끝나면 새 토큰으로 재시도.',
        'Promise는 await 전에 동기적으로 저장해야 한 틱 뒤 도착한 401도 합류한다.',
        '재시도는 요청당 한 번. 재시도도 401이면 실패시켜야 refresh 무한 반복이 없다.',
        'refresh 요청은 인터셉터가 없는 별도 인스턴스로. 같은 인스턴스면 자기 자신을 기다리며 멈춘다.',
        'refresh 실패는 한 번만 처리(로그아웃). "나쁜 예"로 바꿔 돌려 보면 refresh와 로그아웃이 요청 수만큼 일어난다.',
      ]}
      source={[
        { label: '구현', path: 'packages/http/src/tokenRefresh.ts' },
        { label: '테스트', path: 'packages/http/src/tokenRefresh.test.ts' },
        { label: '이 페이지', path: 'apps/web/src/pages/TokenRefreshPage.tsx' },
      ]}
    >
      <div className="stack">
        <div className="row">
          <label className="check">
            <input type="radio" name="strategy" checked={strategy === 'tool'} onChange={() => setStrategy('tool')} />
            attachTokenRefresh
          </label>
          <label className="check">
            <input type="radio" name="strategy" checked={strategy === 'naive'} onChange={() => setStrategy('naive')} />
            나쁜 예: 401마다 refresh
          </label>
        </div>
        <div className="row">
          {SCENARIOS.map((item) => (
            <button key={item.key} type="button" disabled={running} onClick={() => start(item.key)} title={item.expect}>
              {item.label}
            </button>
          ))}
        </div>
        <p className="muted">
          기대 결과: {SCENARIOS.map((item) => `${item.label} → ${item.expect}`).join(' / ')}
        </p>
        <Log lines={lines} empty="버튼을 눌러 시나리오를 실행하세요. 네트워크는 쓰지 않습니다." />
      </div>
    </Page>
  );
}
