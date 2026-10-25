import { useDebouncedSearch } from '@my-tools/react-hooks';
import { useCallback, useEffect, useState } from 'react';
import { Log, Page } from '../components/Page';

const HOTELS = [
  '서울역 호텔', '서울 명동 스테이', '서귀포 오션뷰', '서면 비즈니스 호텔', '부산 해운대 리조트',
  '부산역 게스트하우스', '제주 공항 호텔', '제주 애월 풀빌라', '강릉 경포 호텔', '경주 한옥 스테이',
  '인천공항 캡슐호텔', '여수 밤바다 호텔', '전주 한옥마을 스테이', '속초 바다 뷰', '대구 동성로 호텔',
];

type Line = { id: number; text: string; tone?: string };
let seq = 0; // log line keys
let requestNo = 0; // request numbers shown in the log

/**
 * Fake API: random 200–1500ms latency so responses arrive out of order.
 * It honors the AbortSignal like fetch/axios do.
 */
function fakeSearch(query: string, signal: AbortSignal | undefined, log: (t: string, tone?: string) => void) {
  const ms = 200 + Math.round(Math.random() * 1300);
  const n = ++requestNo;
  log(`#${n} 요청 "${query}" (응답까지 ${ms}ms)`, 'out');
  return new Promise<string[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      log(`#${n} 응답 "${query}"`, 'in');
      resolve(HOTELS.filter((name) => name.includes(query)));
    }, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      log(`#${n} 취소 "${query}"`, 'warn');
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
}

/** ❌ No debounce, no abort: every keystroke fires, and the slowest response wins. */
function NaiveSearch({ query, log }: { query: string; log: (t: string, tone?: string) => void }) {
  const [results, setResults] = useState<string[]>([]);
  const [shownFor, setShownFor] = useState('');

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setShownFor('');
      return;
    }
    fakeSearch(q, undefined, log).then((list) => {
      setResults(list); // may be an old query's result
      setShownFor(q);
    });
  }, [query, log]);

  return <Results results={results} shownFor={shownFor} query={query} />;
}

/** ✅ useDebouncedSearch: one request after typing stops, older ones aborted. */
function HookSearch({ query, log }: { query: string; log: (t: string, tone?: string) => void }) {
  const { data = [], status, query: shownFor, isDebouncing } = useDebouncedSearch(query, (q, signal) =>
    fakeSearch(q, signal, log),
  );
  return (
    <>
      <p className="muted">
        상태: {isDebouncing ? '입력 대기 중' : status}
      </p>
      <Results results={status === 'idle' ? [] : data} shownFor={shownFor} query={query} />
    </>
  );
}

function Results({ results, shownFor, query }: { results: string[]; shownFor: string; query: string }) {
  const mismatch = shownFor !== '' && shownFor !== query.trim();
  return (
    <div className="stack">
      <p className={mismatch ? 'alert' : 'muted'}>
        보여 주는 결과의 검색어: <code>{shownFor || '—'}</code>
        {mismatch && ' ← 입력과 다름!'}
      </p>
      <ul className="results">
        {results.map((name) => (
          <li key={name}>{name}</li>
        ))}
        {shownFor && results.length === 0 && <li className="muted">결과 없음</li>}
      </ul>
    </div>
  );
}

export function SearchPage() {
  const [query, setQuery] = useState('');
  const [naive, setNaive] = useState<Line[]>([]);
  const [hook, setHook] = useState<Line[]>([]);
  const logNaive = useCallback((text: string, tone?: string) => setNaive((p) => [...p.slice(-40), { id: ++seq, text, tone }]), []);
  const logHook = useCallback((text: string, tone?: string) => setHook((p) => [...p.slice(-40), { id: ++seq, text, tone }]), []);

  return (
    <Page
      title="디바운스 검색"
      summary="같은 입력을 두 방식으로 검색합니다. '서울역'처럼 빠르게 쳐 보세요. 가짜 API는 응답 시간이 매번 달라서 순서가 뒤바뀝니다."
      points={[
        '디바운스: 입력이 300ms 멈췄을 때만 요청한다.',
        '검색어가 바뀌면 이전 요청의 AbortSignal을 abort한다. 늦게 온 옛 응답이 최신 결과를 덮지 못한다.',
        '취소는 에러가 아니다. signal.aborted면 결과도 에러도 무시한다.',
        '왼쪽(나쁜 예)은 글자마다 요청하고, 가장 늦게 도착한 응답이 화면에 남을 수 있다.',
        'fetcher에 signal을 넘겨야 실제 요청도 끊긴다: fetch(url, { signal }) / axios.get(url, { signal }).',
      ]}
      source={[
        { label: 'useDebouncedSearch', path: 'packages/react-hooks/src/useDebouncedSearch.ts' },
        { label: 'useDebouncedValue', path: 'packages/react-hooks/src/useDebouncedValue.ts' },
        { label: '이 페이지', path: 'apps/web/src/pages/SearchPage.tsx' },
      ]}
    >
      <input
        className="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="예: 서울역, 부산, 제주"
        aria-label="호텔 검색"
      />
      <div className="split">
        <div className="stack">
          <h3>❌ 디바운스·취소 없음</h3>
          <NaiveSearch query={query} log={logNaive} />
          <Log lines={naive} />
        </div>
        <div className="stack">
          <h3>✅ useDebouncedSearch</h3>
          <HookSearch query={query} log={logHook} />
          <Log lines={hook} />
        </div>
      </div>
      <button
        type="button"
        className="small"
        onClick={() => {
          setNaive([]);
          setHook([]);
        }}
      >
        기록 지우기
      </button>
    </Page>
  );
}
