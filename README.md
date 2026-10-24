# my-tools

pnpm workspace. 태스크는 Turborepo로 돌린다.

| 경로 | 설명 |
| --- | --- |
| [`packages/webview-bridge`](packages/webview-bridge) | 페이지와 iOS WKWebView, Android WebView, React Native WebView 사이의 postMessage 브리지. 런타임 의존성 없음. |
| [`apps/web`](apps/web) | 브리지를 import하는 최소 Vite + React 앱. |

이 저장소는 README만 있었다. 옮길 앱이 없어서, 타입체크와 빌드가 되고 패키지를 실제로 쓰는 앱 타깃으로 `apps/web`을 두었다.

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm dev
```

`pnpm dev`는 웹 앱을 띄운다. `lint`는 각 패키지의 `tsc --noEmit`이다. ESLint 설정은 없다.

네이티브가 따라야 하는 프로토콜은 [packages/webview-bridge/README.md](packages/webview-bridge/README.md)에 있다.
