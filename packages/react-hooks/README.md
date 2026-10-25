# @my-tools/react-hooks

자주 다시 만드는 React 훅 모음입니다. 런타임 의존성은 `react`(18 이상)뿐이라 `src` 폴더를 복사해 써도 됩니다.

| 훅 | 한 줄 설명 |
| --- | --- |
| `useDebouncedValue(value, delay?)` | 값이 `delay`ms 동안 안 바뀌면 그 값을 돌려준다 |
| `useDebouncedSearch(query, fetcher, options?)` | 디바운스 + 이전 요청 취소 + race condition 방지 검색 |

플레이그라운드의 "디바운스 검색" 페이지에서 나쁜 예와 나란히 비교해 볼 수 있습니다.

## useDebouncedSearch

```tsx
import { useDebouncedSearch } from '@my-tools/react-hooks';
import axios from 'axios';

function HotelSearch() {
  const [q, setQ] = useState('');
  const { data = [], status, isDebouncing } = useDebouncedSearch(q, (query, signal) =>
    axios.get<string[]>('/api/hotels', { params: { q: query }, signal }).then((r) => r.data),
  );

  return (
    <>
      <input value={q} onChange={(e) => setQ(e.target.value)} />
      {status === 'loading' && <Spinner />}
      {status === 'error' && <p>검색에 실패했어요.</p>}
      <ul>{data.map((name) => <li key={name}>{name}</li>)}</ul>
    </>
  );
}
```

fetch라면 `(query, signal) => fetch(url, { signal }).then((r) => r.json())`입니다. **`signal`을 꼭 넘기세요.** 안 넘기면 결과는 무시되지만 요청 자체는 끝까지 갑니다.

### 옵션과 반환값

| 이름 | 기본값 | 설명 |
| --- | --- | --- |
| `delay` | `300` | 입력이 멈춰야 하는 시간(ms) |
| `minLength` | `1` | 앞뒤 공백을 뺀 길이가 이보다 짧으면 요청하지 않고 결과를 비움 |

| 반환 | 설명 |
| --- | --- |
| `data` | 마지막으로 끝난 검색 결과. 다음 검색이 진행되는 동안 유지됨 |
| `status` | `'idle' \| 'loading' \| 'success' \| 'error'` |
| `error` | `status === 'error'`일 때의 에러 |
| `query` | 지금 `data`·`status`가 속한 검색어(공백 제거) |
| `isDebouncing` | 아직 입력 대기 중이면 `true` |

### 동작 원리 (학습용)

```
"서"      → 타이머 시작
"서울"    → 이전 타이머 취소, 새 타이머
(300ms)   → 요청 A 시작 (signal A)
"서울역"  → 타이머 → (300ms) → effect cleanup이 signal A를 abort → 요청 B 시작
요청 A가 늦게 도착해도 signal A가 aborted라 무시 → 화면에는 B 결과만
```

1. `useDebouncedValue`로 검색어를 300ms 늦춥니다.
2. 늦춰진 검색어를 deps로 하는 effect에서 요청마다 `AbortController`를 만듭니다.
3. cleanup에서 `abort()`합니다. cleanup은 **다음 effect 직전과 언마운트 때** 실행되니, 검색어가 바뀌면 이전 요청이 정리됩니다.
4. 결과가 와도 `signal.aborted`면 버립니다. 취소로 생긴 에러도 같은 이유로 버립니다.
5. `fetcher`는 ref에 담아 둡니다. 인라인 화살표 함수를 넘겨도 렌더마다 검색이 다시 시작되지 않습니다.

### TanStack Query를 쓰는 프로젝트라면

캐싱이 필요하면 TanStack Query로 바꾸는 게 낫습니다. queryKey가 바뀌면 이전 쿼리의 `signal`을 abort해 줘서, 디바운스만 직접 붙이면 됩니다.

```ts
const debounced = useDebouncedValue(q.trim());
useQuery({
  queryKey: ['hotels', debounced],
  queryFn: ({ signal }) => axios.get('/api/hotels', { params: { q: debounced }, signal }).then((r) => r.data),
  enabled: debounced.length > 0,
});
```

## AI에게 줄 지시문

```text
검색 입력은 @my-tools/react-hooks의 useDebouncedSearch를 쓴다 (packages/react-hooks/README.md).
- fetcher는 (query, signal) => Promise<T> 형태로 쓰고, signal을 fetch/axios에 반드시 넘긴다.
- status('idle'|'loading'|'success'|'error')로 화면 상태를 나눈다. 취소는 에러로 다루지 않는다.
- 캐싱이 필요하면 TanStack Query + useDebouncedValue 조합을 쓴다.
```

## 테스트

```bash
pnpm --filter @my-tools/react-hooks test
```

가짜 타이머로 디바운스, 이전 요청 abort, 늦은 응답 무시, 취소는 에러 아님, minLength, 언마운트 abort, fetcher 교체를 검사합니다.
