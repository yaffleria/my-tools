# my-tools

pnpm workspace run by Turborepo.

| Path | What it is |
| --- | --- |
| [`packages/webview-bridge`](packages/webview-bridge) | Dependency-free postMessage bridge between a page and iOS WKWebView, Android WebView, or React Native WebView. |
| [`apps/web`](apps/web) | Minimal Vite + React app that imports the bridge. |

This repository started as a README. There was no application to move. `apps/web` is here so the workspace has a real app target that typechecks, builds, and consumes the package.

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm dev
```

`pnpm dev` starts the web app. `lint` is `tsc --noEmit` in each package; there is no separate ESLint config.

The protocol the native side has to speak is in [packages/webview-bridge/README.md](packages/webview-bridge/README.md).
