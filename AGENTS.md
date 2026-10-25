# AGENTS.md

AI 코딩 도구가 이 저장소의 코드를 쓰거나, 다른 프로젝트에 가져다 쓸 때 따르는 규칙입니다.

## 저장소

- pnpm workspace + Turborepo. 패키지는 `packages/*`, 플레이그라운드 앱은 `apps/web`.
- TypeScript strict, ESM. 공통 설정은 `tsconfig.base.json`.
- 검증 명령: `pnpm build && pnpm test && pnpm typecheck`. 셋 다 통과해야 끝난 것.
- 패키지에 외부 런타임 의존성을 dependencies로 두지 않는다. 필요한 라이브러리는 peerDependency로만 (React 패키지는 `react`, http는 `axios`).

## 패키지별로 쓰는 법

각 README의 "AI에게 줄 지시문"이 정본이다. 요약:

### @my-tools/webview-bridge (packages/webview-bridge/README.md)

- 메서드·이벤트를 먼저 타입 map으로 정의한다: `WebViewBridge<웹→앱 메서드, 이벤트, 앱→웹 메서드>`, 메서드는 `MethodDef<Payload, Result>`.
- 페이지당 인스턴스 하나. React에서는 `useEffect`에서 만들고 cleanup에서 `destroy()`.
- `on`·`handle`을 등록한 뒤 `announceReady()`를 호출한다.
- `request(name, payload, { timeout })` — timeout은 세 번째 인자. 실패는 `BridgeError.code`로 분기 (`TIMEOUT`, `METHOD_NOT_FOUND`, `TRANSPORT_UNAVAILABLE`, `DESTROYED` …).
- 앱 쪽 코드가 필요하면 README의 iOS/Android/React Native 예시와 "네이티브가 해야 할 일" 체크리스트를 그대로 따른다. `bridge.`로 시작하는 이름은 예약어.

### @my-tools/react-hooks (packages/react-hooks/README.md)

- 검색 입력: `useDebouncedSearch(query, (q, signal) => fetcher, { delay, minLength })`. `signal`을 fetch/axios에 반드시 넘긴다.
- 상태는 `status`로 분기한다. 취소(abort)는 에러로 다루지 않는다.
- 캐싱이 필요하면 TanStack Query + `useDebouncedValue`.

### @my-tools/http (packages/http/README.md)

- axios 인스턴스는 앱에 하나(`api.ts`). 최신 토큰을 붙이는 요청 인터셉터는 직접 쓰고, 401은 `attachTokenRefresh(api, { refresh, onTokenRefreshed, onRefreshFailed })`.
- `refresh`는 `api`가 아닌 기본 `axios`나 인터셉터 없는 인스턴스로 호출한다(같은 인스턴스면 데드락).
- 본문 암호화는 `attachEncryption(api, createHybridEncryptor({ getPublicKey: cachedPublicKey(...) }))`. 서버 규격은 README "서버와 맞출 규격". 클라이언트에 비밀키·대칭키를 두지 않는다.
- 복호화한 응답·평문 본문을 모니터링(Sentry 등)에 넣지 않는다.

### @my-tools/mobile-web (packages/mobile-web/README.md)

- 카메라: `useCameraStream` + `captureFrame`. `denied`·`unsupported`면 `<input type="file" accept="image/*" capture="environment">`로 대체.
- `<video autoPlay playsInline muted>`. WebView라면 앱 쪽 권한 구현이 필요하다고 함께 안내한다.
- 서명: `<SignaturePad ref>` + 핸들 `clear`·`isEmpty`·`toBlob`. 빈 서명 제출 금지.
- 신분증·서명 같은 개인정보는 메모리에서만 다루고 저장·로그에 남기지 않는다.

## 코드 규칙

- effect가 타이머·리스너·구독·요청·카메라를 만들면 cleanup에서 반드시 정리한다.
- 렌더에 쓰이지 않는 값(타이머 id, 스트림, 그리는 중 여부)은 `useRef`. 화면에 보이는 값만 state.
- 외부에서 들어온 값(postMessage, JSON.parse, catch의 error)은 `unknown`으로 받고 좁혀서 쓴다.
- 판별 유니온의 분기는 `default`에서 `never`로 빠짐없이 처리했는지 검사한다.
- 공개 API에는 짧은 JSDoc. 주석은 "왜"를 쓴다.

## 새 도구 추가

1. `packages/<이름>` (설정은 `packages/react-hooks`를 복사).
2. README: 사용법 → 옵션 표 → 동작 원리 → AI에게 줄 지시문.
3. 테스트 가능한 로직은 Vitest 테스트를 같이.
4. `apps/web/src/pages/<이름>Page.tsx` + `App.tsx`의 `ROUTES`에 등록.
