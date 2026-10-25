import { WebViewBridge, type MethodDef } from './index';

type Out = {
  'storage.get': MethodDef<{ key: string }, { value: string | null }>;
  'ui.close': MethodDef<void, void>;
};

type Events = {
  'theme.changed': { mode: 'light' | 'dark' };
  resume: void;
};

type Inbound = {
  'auth.token': MethodDef<void, { token: string }>;
};

/** Compile-only checks. Vitest does not run this file. */
export async function typeSamples(bridge: WebViewBridge<Out, Events, Inbound>): Promise<void> {
  const loaded = await bridge.request('storage.get', { key: 'id' });
  const label: string | null = loaded.value;
  void label;

  await bridge.request('storage.get', { key: 'id' }, { timeout: 50 });
  await bridge.request('ui.close');
  await bridge.request('ui.close', undefined, { timeout: 50 });

  bridge.emit('theme.changed', { mode: 'dark' });
  bridge.emit('resume');
  bridge.on('theme.changed', (payload) => {
    const mode: 'light' | 'dark' = payload.mode;
    void mode;
  });
  bridge.on('resume', () => {});
  bridge.handle('auth.token', async () => ({ token: 'x' }));

  // @ts-expect-error missing key
  bridge.request('storage.get', {});

  // @ts-expect-error unknown method
  bridge.request('missing', {});

  // @ts-expect-error options are the third argument, not the payload
  bridge.request('ui.close', { timeout: 1 });

  // @ts-expect-error mode is not in the union
  bridge.emit('theme.changed', { mode: 'blue' });

  // @ts-expect-error unknown event
  bridge.on('missing', () => {});

  // @ts-expect-error token must be a string
  bridge.handle('auth.token', () => ({ token: 1 }));
}
