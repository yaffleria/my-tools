import { PROTOCOL_VERSION, WebViewBridge, type MethodMap } from '@my-tools/webview-bridge';
import { useEffect, useRef, useState } from 'react';

type DemoEvents = {
  'demo.ping': { at: number };
};

export function App() {
  const bridgeRef = useRef<WebViewBridge<MethodMap, DemoEvents> | null>(null);
  const [ready, setReady] = useState(false);
  const [last, setLast] = useState('No message sent yet.');

  useEffect(() => {
    const bridge = new WebViewBridge<MethodMap, DemoEvents>({
      listen: false,
      transport: {
        name: 'demo',
        post(envelope) {
          setLast(JSON.stringify(envelope, null, 2));
        },
      },
    });
    bridgeRef.current = bridge;
    setReady(true);
    return () => {
      bridge.destroy();
      bridgeRef.current = null;
      setReady(false);
    };
  }, []);

  return (
    <main>
      <h1>my-tools</h1>
      <p>WebView bridge protocol version {PROTOCOL_VERSION}.</p>
      <button
        type="button"
        disabled={!ready}
        onClick={() => {
          bridgeRef.current?.emit('demo.ping', { at: Date.now() });
        }}
      >
        Send ping
      </button>
      <pre aria-live="polite">{last}</pre>
    </main>
  );
}
