# my-tools

배우면서 만들고, 필요할 때 꺼내 쓰는 프론트엔드 도구 모음입니다.

- **체험**: https://my-tools-yaffleria.vercel.app — 각 도구를 직접 눌러 보는 플레이그라운드 (카메라·서명은 휴대폰으로)
- **학습**: 패키지마다 README에 "동작 원리" 절이 있고, 플레이그라운드 페이지 아래에 핵심과 코드 위치가 있습니다.
- **꺼내 쓰기**: 패키지 폴더를 복사하거나, AI에게 [AGENTS.md](AGENTS.md)와 패키지 README를 참고시키면 됩니다.

## 패키지

| 패키지 | 무엇 | 플레이그라운드 |
| --- | --- | --- |
| [`@my-tools/webview-bridge`](packages/webview-bridge) | 웹 ↔ 앱(iOS·Android·React Native) WebView 통신. 하나의 봉투 형식, 요청-응답 짝짓기, 타임아웃, 준비 신호 | `#bridge` |
| [`@my-tools/react-hooks`](packages/react-hooks) | `useDebouncedValue`, `useDebouncedSearch`(디바운스 + 요청 취소 + race condition 방지) | `#search` |
| [`@my-tools/mobile-web`](packages/mobile-web) | `useCameraStream`·`captureFrame`(카메라), `SignaturePad`(전자서명) | `#camera`, `#signature` |
| [`apps/web`](apps/web) | 위 패키지를 실제로 쓰는 플레이그라운드 (Vite + React) | — |

모든 패키지는 외부 런타임 의존성이 없습니다. React 패키지는 `react`만 peer로 필요합니다.

## 구조

```
my-tools/
├── apps/
│   └── web/                 플레이그라운드. src/pages/<도구>Page.tsx 하나가 한 페이지
├── packages/
│   ├── webview-bridge/      src/index.ts 한 파일이 전부. README = 프로토콜 스펙 + 네이티브 예시
│   ├── react-hooks/         훅 하나 = 파일 하나 (+ .test.ts)
│   └── mobile-web/          camera.ts, SignaturePad.tsx
├── AGENTS.md                AI에게 줄 저장소 규칙
├── turbo.json               태스크 순서 (패키지 build가 앱보다 먼저)
└── pnpm-workspace.yaml
```

pnpm workspace로 패키지를 묶고, Turborepo가 `build`·`test`·`typecheck`를 의존 순서대로 돌립니다. 앱은 `"@my-tools/react-hooks": "workspace:*"`처럼 패키지를 의존성으로 씁니다.

## 명령

```bash
pnpm install
pnpm dev         # 패키지 빌드 후 플레이그라운드 실행 (http://localhost:5173)
pnpm test        # Vitest (webview-bridge, react-hooks)
pnpm typecheck
pnpm build
```

`lint`는 각 패키지의 `tsc --noEmit`입니다. 패키지 하나만: `pnpm --filter @my-tools/react-hooks test`.

## 다른 프로젝트에서 꺼내 쓰기

1. **같은 모노레포라면** 의존성에 `"@my-tools/<이름>": "workspace:*"`.
2. **다른 프로젝트라면** `packages/<이름>/src`를 복사합니다. 테스트 파일(`*.test.ts`)은 빼도 됩니다.
3. **AI에게 맡길 때는** 아래처럼 지시하면 됩니다.

```text
https://github.com/yaffleria/my-tools 의 AGENTS.md를 따르고,
packages/<이름>/README.md의 사용법과 "AI에게 줄 지시문"대로 구현해줘.
```

## 새 도구를 추가할 때

1. 재사용할 코드는 `packages/<이름>`에 (package.json·tsconfig는 `react-hooks`를 복사해 이름만 바꾸기).
2. README에 사용법 → 옵션 표 → "동작 원리" → "AI에게 줄 지시문" 순서로 쓰기.
3. `apps/web/src/pages/<이름>Page.tsx`에 체험 페이지를 만들고 `App.tsx`의 `ROUTES`에 한 줄 추가.
4. `pnpm build && pnpm test && pnpm typecheck`가 통과하면 main에 merge. Vercel이 자동으로 배포합니다.
