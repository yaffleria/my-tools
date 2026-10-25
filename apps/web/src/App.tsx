import { useEffect, useState } from 'react';
import { BridgePage } from './pages/BridgePage';
import { CameraPage } from './pages/CameraPage';
import { HomePage } from './pages/HomePage';
import { SearchPage } from './pages/SearchPage';
import { SignaturePage } from './pages/SignaturePage';

const ROUTES = {
  '': { label: '소개', Page: HomePage },
  bridge: { label: 'WebView 브리지', Page: BridgePage },
  search: { label: '디바운스 검색', Page: SearchPage },
  camera: { label: '카메라', Page: CameraPage },
  signature: { label: '서명', Page: SignaturePage },
} as const;

type RouteKey = keyof typeof ROUTES;

function readRoute(): RouteKey {
  const key = window.location.hash.replace(/^#\/?/, '');
  return key in ROUTES ? (key as RouteKey) : '';
}

/** Hash routing keeps the site static (no server rewrites) and every demo linkable. */
export function App() {
  const [route, setRoute] = useState<RouteKey>(readRoute);

  useEffect(() => {
    const onHash = () => {
      setRoute(readRoute());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const { Page } = ROUTES[route];

  return (
    <>
      <header className="top">
        <a href="#" className="brand">
          my-tools
        </a>
        <nav>
          {(Object.keys(ROUTES) as RouteKey[]).map((key) => (
            <a key={key} href={`#${key}`} aria-current={route === key ? 'page' : undefined}>
              {ROUTES[key].label}
            </a>
          ))}
        </nav>
      </header>
      <main>
        <Page key={route} />
      </main>
      <footer>
        <a href="https://github.com/yaffleria/my-tools" target="_blank" rel="noreferrer">
          github.com/yaffleria/my-tools
        </a>
      </footer>
    </>
  );
}
